const SESSION_KEY = 'usageSession';
const SESSION_MAX_AGE = 24 * 60 * 60 * 1000;
const ALLOWED_EVENTS = new Set(['pdf_imported', 'phone_connected', 'phone_navigation', 'session_ended']);

export function getUsageSessionId(storage, crypto, now = Date.now()) {
  try {
    storage ??= globalThis.sessionStorage;
    crypto ??= globalThis.crypto;
    const current = JSON.parse(storage.getItem(SESSION_KEY) ?? 'null');
    if (typeof current?.id === 'string' && Number.isFinite(current.createdAt)
      && now >= current.createdAt && now - current.createdAt < SESSION_MAX_AGE) return current.id;
    const id = crypto.randomUUID();
    storage.setItem(SESSION_KEY, JSON.stringify({ id, createdAt: now }));
    return id;
  } catch {
    return null;
  }
}

export async function trackUsageEvent(event, {
  keepalive = false,
  storage,
  crypto,
  fetch: fetchImpl,
  sendBeacon,
} = {}) {
  if (!ALLOWED_EVENTS.has(event)) return;
  const sessionId = getUsageSessionId(storage, crypto);
  if (!sessionId) return;
  const body = JSON.stringify({ event, sessionId });
  if (keepalive && event === 'session_ended') {
    try {
      const beacon = sendBeacon ?? globalThis.navigator?.sendBeacon?.bind(globalThis.navigator);
      if (beacon?.('/api/usage-analytics/event', new Blob([body], { type: 'application/json' }))) return;
    } catch {
      // A failed beacon falls back to keepalive fetch.
    }
  }
  try {
    await (fetchImpl ?? globalThis.fetch)('/api/usage-analytics/event', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body, ...(keepalive ? { keepalive: true } : {}),
    });
  } catch {
    // Analytics must never change the presentation result.
  }
}
