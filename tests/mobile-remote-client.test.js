import test from 'node:test';
import assert from 'node:assert/strict';
import { createMobileRemoteClient } from '../src/mobile-remote-client.js';

class FakeWebSocket {
  static instances = [];
  static OPEN = 1;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  send(value) { this.sent.push(JSON.parse(value)); }
  open() { this.readyState = 1; this.onopen?.(); }
  message(value) { return this.onmessage?.({ data: JSON.stringify(value) }); }
  raw(value) { this.onmessage?.({ data: value }); }
  close() { this.readyState = 3; this.onclose?.(); }
}

function setup(options = {}, t) {
  FakeWebSocket.instances.length = 0;
  const events = [];
  const commands = [];
  const client = createMobileRemoteClient({
    WebSocketImpl: FakeWebSocket,
    hostCredential: 'host-secret',
    onConnection: (event) => events.push(event),
    onCommand: (command) => { commands.push(command); return true; },
    location: { protocol: 'http:', host: '127.0.0.1:5173' },
    ...options,
  });
  t?.after(() => client.close());
  client.connect();
  return { client, socket: FakeWebSocket.instances[0], events, commands };
}

test('authenticates first, then publishes only the latest sanitized state', () => {
  const { client, socket, events } = setup();
  assert.equal(socket.url, 'ws://127.0.0.1:5173/ws/mobile-remote/presenter');
  client.publishState({ index: 0, total: 4, busy: false, slide: { title: 'secret' } });
  socket.open();
  assert.deepEqual(socket.sent, [{ type: 'presenter', credential: 'host-secret' }]);
  client.publishState({ index: 2, total: 4, busy: true, filename: 'private.pdf' });
  socket.message({ type: 'presenterReady' });
  assert.deepEqual(events, [{ type: 'authenticated' }]);
  assert.deepEqual(socket.sent[1], { type: 'state', index: 2, total: 4, busy: true });
  client.publishState({ index: 3, total: 4, busy: false, camera: 'private' });
  assert.deepEqual(socket.sent[2], { type: 'state', index: 3, total: 4, busy: false });
  client.publishState({ index: -1, total: 4, busy: false });
  assert.equal(socket.sent.length, 3);
});

test('publishes Canva readiness without inventing slide position', () => {
  const { client, socket } = setup();
  const state = { target: 'canva', ready: true, index: null, total: null, busy: false };

  assert.equal(client.publishState(state), true);
  socket.open();
  socket.message({ type: 'presenterReady' });

  assert.deepEqual(socket.sent.at(-1), { type: 'state', ...state });
});

test('valid commands reach the bridge and receive acknowledgements; malformed messages are ignored', () => {
  const { client, socket, commands } = setup();
  socket.open();
  socket.message({ type: 'presenterReady' });
  for (const value of [
    { type: 'command', id: 'a', action: 'next' },
    { type: 'command', id: 'b', action: 'previous' },
    { type: 'command', id: 'c', action: 'goTo', index: 0 },
  ]) socket.message(value);
  assert.deepEqual(commands, [
    { action: 'next' }, { action: 'previous' }, { action: 'goTo', index: 0 },
  ]);
  assert.deepEqual(socket.sent.slice(1), [
    { type: 'commandAck', id: 'a', accepted: true },
    { type: 'commandAck', id: 'b', accepted: true },
    { type: 'commandAck', id: 'c', accepted: true },
  ]);
  const before = socket.sent.length;
  for (const value of [
    '{bad', 'null', '[]', JSON.stringify({ type: 'unknown' }),
    JSON.stringify({ type: 'command', id: '', action: 'next' }),
    JSON.stringify({ type: 'command', id: 'd', action: 'goTo', index: -1 }),
    JSON.stringify({ type: 'command', id: 'e', action: 'next', index: 2 }),
    JSON.stringify({ type: 'command', id: 'f', action: 'goTo', index: 1.5 }),
  ]) socket.raw(value);
  assert.equal(socket.sent.length, before);
  assert.equal(commands.length, 3);
  client.close();
});

test('waits for an asynchronous target result before acknowledging a phone command', async () => {
  let resolveCommand;
  const { socket } = setup({
    onCommand: () => new Promise((resolve) => { resolveCommand = resolve; }),
  });
  socket.open();
  socket.message({ type: 'presenterReady' });

  const handling = socket.message({ type: 'command', id: 'async-next', action: 'next' });
  assert.equal(socket.sent.some(({ type }) => type === 'commandAck'), false);

  resolveCommand(false);
  await handling;
  assert.deepEqual(socket.sent.at(-1), {
    type: 'commandAck', id: 'async-next', accepted: false,
  });
});

test('pending command results survive cache pressure and acknowledge once when resolved', async (t) => {
  let resolvePending;
  let calls = 0;
  const { socket } = setup({
    onCommand: () => {
      calls++;
      if (calls === 1) return new Promise((resolve) => { resolvePending = resolve; });
      return true;
    },
  }, t);
  socket.open();
  socket.message({ type: 'presenterReady' });
  socket.message({ type: 'command', id: 'pending', action: 'next' });

  for (let index = 0; index < 1_999; index++) {
    socket.message({ type: 'command', id: `sync-${index}`, action: 'next' });
  }
  const ackCountBeforeReplay = socket.sent.filter(({ type, id }) => type === 'commandAck' && id === 'pending').length;
  socket.message({ type: 'command', id: 'pending', action: 'next' });
  assert.equal(calls, 2_000);
  assert.equal(socket.sent.filter(({ type, id }) => type === 'commandAck' && id === 'pending').length, ackCountBeforeReplay);

  resolvePending(true);
  await Promise.resolve();
  assert.equal(socket.sent.filter(({ type, id }) => type === 'commandAck' && id === 'pending').length, 1);
  assert.deepEqual(socket.sent.filter(({ type, id }) => type === 'commandAck' && id === 'pending'), [
    { type: 'commandAck', id: 'pending', accepted: true },
  ]);
});

test('deduplicates every command in the latest 2,000 IDs while older pending work still acknowledges', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolvePending;
  let calls = 0;
  const { client, socket: first } = setup({
    autoReconnect: true,
    onCommand: () => {
      calls++;
      return calls === 1 ? new Promise((resolve) => { resolvePending = resolve; }) : true;
    },
  }, t);
  first.open();
  first.message({ type: 'presenterReady' });
  first.message({ type: 'command', id: 'pending-A', action: 'next' });
  for (let index = 1; index <= 2_000; index++) {
    first.message({ type: 'command', id: `completed-B${index}`, action: 'next' });
  }
  first.close();
  t.mock.timers.tick(250);

  const replacement = FakeWebSocket.instances[1];
  replacement.open();
  replacement.message({ type: 'presenterReady' });
  replacement.message({ type: 'command', id: 'completed-B1', action: 'next' });
  assert.equal(calls, 2_001, 'replayed B1 must use its cached result');
  assert.deepEqual(replacement.sent.at(-1), {
    type: 'commandAck', id: 'completed-B1', accepted: true,
  });

  resolvePending(true);
  await Promise.resolve();
  assert.equal(calls, 2_001, 'evicted pending A must not be executed again');
  assert.deepEqual(replacement.sent.at(-1), {
    type: 'commandAck', id: 'pending-A', accepted: true,
  });
  client.close();
});

test('rejects a new command when all 2,000 cached results are pending', (t) => {
  let calls = 0;
  const { socket } = setup({
    onCommand: () => {
      calls++;
      return new Promise(() => {});
    },
  }, t);
  socket.open();
  socket.message({ type: 'presenterReady' });
  for (let index = 0; index < 2_000; index++) {
    socket.message({ type: 'command', id: `pending-${index}`, action: 'next' });
  }

  socket.message({ type: 'command', id: 'overflow', action: 'next' });
  assert.equal(calls, 2_000);
  assert.deepEqual(socket.sent.at(-1), { type: 'commandAck', id: 'overflow', accepted: false });
});

test('repeated overflow does not exceed 2,000 unresolved command executions', async (t) => {
  const pendingResolvers = [];
  let calls = 0;
  const { socket } = setup({
    onCommand: () => {
      calls++;
      return new Promise((resolve) => pendingResolvers.push(resolve));
    },
  }, t);
  socket.open();
  socket.message({ type: 'presenterReady' });
  for (let index = 0; index < 2_000; index++) {
    socket.message({ type: 'command', id: `in-flight-${index}`, action: 'next' });
  }
  for (let index = 0; index < 10; index++) {
    socket.message({ type: 'command', id: `overflow-${index}`, action: 'next' });
  }
  assert.equal(calls, 2_000);
  assert.deepEqual(socket.sent.filter(({ type, id }) => type === 'commandAck' && id.startsWith('overflow-')).length, 10);
  assert.ok(socket.sent.filter(({ type, id }) => type === 'commandAck' && id.startsWith('overflow-')).every(({ accepted }) => !accepted));

  pendingResolvers[0](true);
  await Promise.resolve();
  assert.equal(socket.sent.filter(({ type, id }) => type === 'commandAck' && id === 'in-flight-0').length, 1);
  assert.equal(calls, 2_000);
});

test('callback failure acknowledges false and host events use the connection callback', () => {
  const { socket, events } = setup({ onCommand: () => { throw new Error('bridge failed'); } });
  socket.open();
  socket.message({ type: 'presenterReady' });
  socket.message({ type: 'command', id: 'x', action: 'next' });
  assert.deepEqual(socket.sent.at(-1), { type: 'commandAck', id: 'x', accepted: false });
  socket.message({ type: 'phonePaired' });
  socket.message({ type: 'inviteExpired' });
  socket.message({ type: 'sessionEnded' });
  assert.deepEqual(events, [
    { type: 'authenticated' }, { type: 'phonePaired' },
    { type: 'inviteExpired' }, { type: 'sessionEnded' },
  ]);
});

test('rejection and close are reported; closed clients send nothing and never reconnect', () => {
  const { client, socket, events } = setup();
  socket.open();
  socket.message({ type: 'presenterRejected', reason: 'invalid-credential' });
  assert.deepEqual(events, [{ type: 'rejected', reason: 'invalid-credential' }]);
  socket.message({ type: 'presenterReady' });
  assert.deepEqual(events, [{ type: 'rejected', reason: 'invalid-credential' }]);
  socket.close();
  assert.deepEqual(events.at(-1), { type: 'closed' });
  client.publishState({ index: 0, total: 4, busy: false });
  client.connect();
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(socket.sent.length, 1);
});

test('reasonless presenter rejection is forwarded for the UI fallback', () => {
  const { socket, events } = setup();
  socket.open();
  socket.message({ type: 'presenterRejected' });
  assert.deepEqual(events, [{ type: 'rejected' }]);
});

test('explicit close prevents late open, ready, command and state sends', () => {
  const { client, socket, commands } = setup();
  client.publishState({ index: 0, total: 4, busy: false });
  client.close();
  socket.open();
  socket.message({ type: 'presenterReady' });
  socket.message({ type: 'command', id: 'late', action: 'next' });
  client.publishState({ index: 1, total: 4, busy: false });
  assert.deepEqual(socket.sent, []);
  assert.deepEqual(commands, []);
});

test('reconnection is opt-in and waits 250ms after a transport close', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const local = setup({}, t);
  local.socket.close();
  t.mock.timers.tick(250);
  assert.equal(FakeWebSocket.instances.length, 1);
  local.client.close();

  const hosted = setup({ autoReconnect: true }, t);
  hosted.socket.close();
  t.mock.timers.tick(249);
  assert.equal(FakeWebSocket.instances.length, 1);
  t.mock.timers.tick(1);
  assert.equal(FakeWebSocket.instances.length, 2);
  hosted.client.close();
});

test('retry delay grows to 5 seconds, then successful authentication resets it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, socket: first } = setup({ autoReconnect: true }, t);
  const delays = [250, 500, 1_000, 2_000, 4_000, 5_000, 5_000];
  let current = first;

  for (const [index, delay] of delays.entries()) {
    current.close();
    const count = FakeWebSocket.instances.length;
    t.mock.timers.tick(delay - 1);
    assert.equal(FakeWebSocket.instances.length, count, `must wait ${delay}ms`);
    t.mock.timers.tick(1);
    assert.equal(FakeWebSocket.instances.length, count + 1, `must reconnect after ${delay}ms`);
    current = FakeWebSocket.instances.at(-1);
    if (index === delays.length - 1) {
      current.open();
      current.message({ type: 'presenterReady' });
    }
  }

  current.close();
  const count = FakeWebSocket.instances.length;
  t.mock.timers.tick(249);
  assert.equal(FakeWebSocket.instances.length, count);
  t.mock.timers.tick(1);
  assert.equal(FakeWebSocket.instances.length, count + 1);
  client.close();
});

test('reconnect authenticates again and publishes only the latest sanitized state', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, socket: first, commands, events } = setup({ autoReconnect: true }, t);
  client.publishState({ index: 1, total: 5, busy: false, secret: 'drop' });
  first.open();
  first.message({ type: 'presenterReady' });
  client.publishState({ index: 3, total: 5, busy: true, filename: 'drop.pdf' });
  first.close();
  t.mock.timers.tick(250);

  const second = FakeWebSocket.instances[1];
  assert.ok(second, 'a replacement socket should be created');
  second.open();
  assert.deepEqual(second.sent, [{ type: 'presenter', credential: 'host-secret' }]);
  second.message({ type: 'presenterReady' });
  assert.deepEqual(second.sent, [
    { type: 'presenter', credential: 'host-secret' },
    { type: 'state', index: 3, total: 5, busy: true },
  ]);
  const currentEvents = [...events];
  const oldSent = [...first.sent];
  first.message({ type: 'presenterReady' });
  first.message({ type: 'presenterRejected', reason: 'invalid-credential' });
  first.message({ type: 'sessionEnded' });
  first.close();
  assert.deepEqual(first.sent, oldSent);
  assert.deepEqual(events, currentEvents);
  client.publishState({ index: 4, total: 5, busy: false });
  assert.deepEqual(second.sent.at(-1), { type: 'state', index: 4, total: 5, busy: false });
  first.message({ type: 'command', id: 'old-socket-command', action: 'next' });
  assert.deepEqual(commands, []);
  client.close();
});

test('replayed command IDs across reconnect reuse saved acknowledgements', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, socket: first, commands } = setup({ autoReconnect: true }, t);
  first.open();
  first.message({ type: 'presenterReady' });
  first.message({ type: 'command', id: 'stable-command', action: 'next' });
  const acknowledgement = { type: 'commandAck', id: 'stable-command', accepted: true };
  assert.deepEqual(first.sent.at(-1), acknowledgement);
  first.close();
  t.mock.timers.tick(250);

  const second = FakeWebSocket.instances[1];
  assert.ok(second, 'a replacement socket should be created');
  second.open();
  second.message({ type: 'presenterReady' });
  second.message({ type: 'command', id: 'stable-command', action: 'next' });
  assert.equal(commands.length, 1);
  assert.deepEqual(second.sent.at(-1), acknowledgement);
  client.close();

  let resolveCommand;
  let deferredCommandCalls = 0;
  const deferred = setup({
    autoReconnect: true,
    onCommand: () => {
      deferredCommandCalls++;
      return new Promise((resolve) => { resolveCommand = resolve; });
    },
  }, t);
  deferred.socket.open();
  deferred.socket.message({ type: 'presenterReady' });
  const pending = deferred.socket.message({ type: 'command', id: 'pending-command', action: 'next' });
  deferred.socket.close();
  t.mock.timers.tick(250);
  const replacement = FakeWebSocket.instances.at(-1);
  replacement.open();
  replacement.message({ type: 'presenterReady' });
  const duplicate = replacement.message({ type: 'command', id: 'pending-command', action: 'next' });
  assert.equal(deferredCommandCalls, 1);
  assert.equal(replacement.sent.some(({ type }) => type === 'commandAck'), false);
  const eventsBeforeCompletion = [...deferred.events];
  resolveCommand(true);
  await Promise.all([pending, duplicate]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(deferred.socket.sent, [{ type: 'presenter', credential: 'host-secret' }]);
  assert.equal(deferred.socket.sent.some(({ type }) => type === 'commandAck'), false);
  assert.deepEqual(replacement.sent.filter(({ type }) => type === 'commandAck'), [{
    type: 'commandAck', id: 'pending-command', accepted: true,
  }]);
  assert.deepEqual(deferred.events, eventsBeforeCompletion);
  deferred.client.publishState({ index: 2, total: 5, busy: false });
  assert.deepEqual(replacement.sent.at(-1), { type: 'state', index: 2, total: 5, busy: false });
  client.close();
  deferred.client.close();
});

test('async command results wait for replacement authentication before replay acknowledgement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolveCommand;
  let calls = 0;
  const { client, socket: first } = setup({
    autoReconnect: true,
    onCommand: () => {
      calls++;
      return new Promise((resolve) => { resolveCommand = resolve; });
    },
  }, t);
  first.open();
  first.message({ type: 'presenterReady' });
  first.message({ type: 'command', id: 'auth-pending', action: 'next' });
  first.close();
  t.mock.timers.tick(250);

  const replacement = FakeWebSocket.instances[1];
  replacement.open();
  resolveCommand(true);
  await Promise.resolve();
  assert.equal(replacement.sent.some(({ type }) => type === 'commandAck'), false);

  replacement.message({ type: 'presenterReady' });
  replacement.message({ type: 'command', id: 'auth-pending', action: 'next' });
  assert.equal(calls, 1);
  assert.deepEqual(replacement.sent.at(-1), {
    type: 'commandAck', id: 'auth-pending', accepted: true,
  });
  client.close();
});

test('retryable and terminal auth outcomes are fenced from stale sockets', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const retry = setup({ autoReconnect: true }, t);
  retry.socket.open();
  retry.socket.message({ type: 'presenterRejected', reason: 'already-connected' });
  assert.deepEqual(retry.events, [{ type: 'reconnecting' }]);
  t.mock.timers.tick(250);
  assert.equal(FakeWebSocket.instances.length, 2);
  retry.client.close();

  for (const reason of ['invalid-credential', 'session-missing', 'session-ended', 'invalid-session-state']) {
    const attempt = setup({ autoReconnect: true }, t);
    attempt.socket.open();
    attempt.socket.message({ type: 'presenterRejected', reason });
    attempt.socket.close();
    t.mock.timers.tick(500);
    assert.equal(FakeWebSocket.instances.length, 1, `${reason} should stop retries`);
    attempt.client.close();
  }

  const terminal = setup({ autoReconnect: true }, t);
  terminal.socket.open();
  terminal.socket.message({ type: 'presenterReady' });
  terminal.socket.message({ type: 'sessionEnded' });
  terminal.socket.close();
  t.mock.timers.tick(500);
  assert.equal(FakeWebSocket.instances.length, 1);
  terminal.client.close();

  const explicit = setup({ autoReconnect: true }, t);
  const old = explicit.socket;
  const oldMessage = old.onmessage;
  old.close();
  explicit.client.close();
  t.mock.timers.tick(500);
  old.open();
  oldMessage({ data: JSON.stringify({ type: 'presenterReady' }) });
  oldMessage({ data: JSON.stringify({ type: 'command', id: 'late-old', action: 'next' }) });
  await Promise.resolve();
  assert.equal(FakeWebSocket.instances.at(-1), old);
  assert.deepEqual(explicit.commands, []);
});
