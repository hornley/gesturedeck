const PRESENTER_PATH = '/ws/mobile-remote/presenter';
const PHONE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const DEVICE_TYPES = new Set(['iphone', 'android-phone', 'phone']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeState(value) {
  if (!isRecord(value) || typeof value.busy !== 'boolean') return null;
  if (value.target === 'canva') {
    if (value.type !== undefined && value.type !== 'state') return null;
    if (Object.keys(value).filter((key) => key !== 'type').sort().join(',') !== 'busy,index,ready,target,total'
      || value.ready !== true && value.ready !== false
      || value.index !== null
      || value.total !== null
      || value.busy !== false) return null;
    return { target: 'canva', ready: value.ready, index: null, total: null, busy: false };
  }
  if ('target' in value
    || !Number.isSafeInteger(value.index)
    || !Number.isSafeInteger(value.total)
    || value.total < 1
    || value.index < 0
    || value.index >= value.total) return null;
  return { index: value.index, total: value.total, busy: value.busy };
}

function validCommand(message) {
  if (!isRecord(message) || message.type !== 'command'
    || typeof message.id !== 'string' || message.id.length < 1 || message.id.length > 128
    || message.id.trim() !== message.id
    // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted command IDs.
    || /[\s\u0000-\u001f\u007f]/.test(message.id)) return false;
  const keys = Object.keys(message).sort();
  if (message.action === 'previous' || message.action === 'next') {
    return keys.join(',') === 'action,id,type';
  }
  return message.action === 'goTo'
    && keys.join(',') === 'action,id,index,type'
    && Number.isSafeInteger(message.index)
    && message.index >= 0;
}

function validPhoneList(message) {
  if (Object.keys(message).sort().join(',') !== 'phones,type'
    || message.type !== 'phones'
    || !Array.isArray(message.phones)
    || message.phones.length > 8) return false;
  const ids = new Set();
  return message.phones.every((phone) => {
    if (!isRecord(phone)
      || Object.keys(phone).sort().join(',') !== 'deviceType,label,phoneId,status'
      || typeof phone.phoneId !== 'string' || !PHONE_ID_PATTERN.test(phone.phoneId)
      || ids.has(phone.phoneId)
      || typeof phone.label !== 'string' || phone.label.length < 1 || phone.label.length > 64
      || !DEVICE_TYPES.has(phone.deviceType)
      || !['connected', 'reconnecting'].includes(phone.status)) return false;
    ids.add(phone.phoneId);
    return true;
  });
}

/**
 * Connect a presenter to its local or cloud server. onConnection receives
 * { type: 'authenticated' | 'rejected' | 'closed' | 'phonePaired' |
 *   'phones' | 'inviteExpired' | 'sessionEnded' | 'reconnecting', reason?: string }.
 * A rejection may omit its reason. Reconnection is opt-in.
 */
export function createMobileRemoteClient({
  WebSocketImpl = globalThis.WebSocket,
  onCommand = () => false,
  onConnection = () => {},
  hostCredential,
  path = PRESENTER_PATH,
  location = globalThis.location,
  autoReconnect = false,
}) {
  if (typeof WebSocketImpl !== 'function') throw new TypeError('WebSocket is unavailable');
  if (typeof onCommand !== 'function' || typeof onConnection !== 'function') {
    throw new TypeError('Callbacks must be functions');
  }
  if (typeof hostCredential !== 'string' || hostCredential.length === 0) {
    throw new TypeError('hostCredential must be a non-empty string');
  }
  if (typeof path !== 'string' || !path.startsWith('/') || /[\r\n]/.test(path)) {
    throw new TypeError('path must be an absolute WebSocket path');
  }

  let socket;
  let authenticated = false;
  let rejected = false;
  let closed = false;
  let disposed = false;
  let terminal = false;
  let retryTimer;
  let retryIndex = 0;
  let latestState;
  const commandResults = new Map();

  const retryDelays = [250, 500, 1_000, 2_000, 4_000, 5_000];

  function isOpen() { return socket?.readyState === (WebSocketImpl.OPEN ?? 1); }

  function send(message, target = socket) {
    if (disposed || target !== socket || target?.readyState !== (WebSocketImpl.OPEN ?? 1)) return false;
    try {
      target.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  function publishState(snapshot) {
    if (closed) return false;
    const sanitized = sanitizeState(snapshot);
    if (!sanitized) return false;
    latestState = sanitized;
    if (authenticated) send({ type: 'state', ...latestState });
    return true;
  }

  function handleMessage(target, event) {
    if (target !== socket || disposed || terminal || rejected || !isOpen() || typeof event?.data !== 'string') return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (!isRecord(message)) return;
    if (message.type === 'presenterReady' && Object.keys(message).length === 1 && !authenticated) {
      authenticated = true;
      retryIndex = 0;
      onConnection({ type: 'authenticated' });
      if (latestState) send({ type: 'state', ...latestState });
      return;
    }
    if (message.type === 'presenterRejected'
      && Object.keys(message).every((key) => key === 'type' || key === 'reason')) {
      if (autoReconnect && message.reason === 'already-connected') {
        retry(target);
        return;
      }
      rejected = true;
      const rejection = { type: 'rejected' };
      if (typeof message.reason === 'string') rejection.reason = message.reason;
      onConnection(rejection);
      terminal = true;
      return;
    }
    if (!authenticated) return;
    if (message.type === 'phones') {
      if (validPhoneList(message)) {
        onConnection({
          type: 'phones',
          phones: message.phones.map(({ phoneId, label, deviceType, status }) => ({ phoneId, label, deviceType, status })),
        });
      }
      return;
    }
    if (validCommand(message)) {
      if (commandResults.has(message.id)) {
        const cached = commandResults.get(message.id);
        if (cached !== null) send({ type: 'commandAck', id: message.id, accepted: cached });
        return;
      }
      commandResults.set(message.id, null);
      if (commandResults.size > 2_000) commandResults.delete(commandResults.keys().next().value);
      const command = message.action === 'goTo'
        ? { action: message.action, index: message.index }
        : { action: message.action };
      let result = false;
      try { result = onCommand(command); } catch { /* Reject failed commands. */ }
      const complete = (accepted) => {
        if (disposed || !commandResults.has(message.id)) return;
        const value = Boolean(accepted);
        commandResults.set(message.id, value);
        if (authenticated) send({ type: 'commandAck', id: message.id, accepted: value });
      };
      if (result && typeof result.then === 'function') Promise.resolve(result).then(complete, () => complete(false));
      else complete(result);
      return;
    }
    if (['phonePaired', 'inviteExpired', 'sessionEnded'].includes(message.type)
      && Object.keys(message).length === 1) {
      if (message.type === 'sessionEnded') {
        terminal = true;
        clearTimeout(retryTimer);
        commandResults.clear();
        authenticated = false;
      }
      onConnection({ type: message.type });
    }
  }

  function connect() {
    if (socket || disposed || terminal) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const target = new WebSocketImpl(`${protocol}//${location.host}${path}`);
    socket = target;
    rejected = false;
    target.onopen = () => send({ type: 'presenter', credential: hostCredential }, target);
    target.onmessage = (event) => handleMessage(target, event);
    target.onclose = () => {
      if (target !== socket || disposed) return;
      socket = undefined;
      authenticated = false;
      rejected = false;
      if (autoReconnect && !terminal) retry();
      else {
        closed = true;
        terminal = true;
        onConnection({ type: 'closed' });
      }
    };
  }

  function retry(target) {
    if (disposed || terminal || retryTimer) return;
    if (target === socket) {
      socket = undefined;
      authenticated = false;
      rejected = false;
      try { target.close(); } catch { /* The retry does not depend on closing a stale transport. */ }
    }
    onConnection({ type: 'reconnecting' });
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      retryIndex = Math.min(retryIndex + 1, retryDelays.length - 1);
      connect();
    }, retryDelays[retryIndex]);
  }

  function close() {
    if (disposed) return;
    disposed = true;
    closed = true;
    authenticated = false;
    latestState = undefined;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    commandResults.clear();
    const target = socket;
    socket = undefined;
    target?.close();
    onConnection({ type: 'closed' });
  }

  function removePhone(phoneId) {
    if (!authenticated || !isOpen() || typeof phoneId !== 'string' || !PHONE_ID_PATTERN.test(phoneId)) return false;
    return send({ type: 'removePhone', phoneId });
  }

  return { connect, publishState, removePhone, close };
}
