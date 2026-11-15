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

function setup(options = {}) {
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
  const local = setup();
  local.socket.close();
  assert.equal(FakeWebSocket.instances.length, 1);

  const hosted = setup({ autoReconnect: true });
  hosted.socket.close();
  t.mock.timers.tick(249);
  assert.equal(FakeWebSocket.instances.length, 1);
  t.mock.timers.tick(1);
  assert.equal(FakeWebSocket.instances.length, 2);
});

test('reconnect authenticates again and publishes only the latest sanitized state', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, socket: first, commands } = setup({ autoReconnect: true });
  client.publishState({ index: 1, total: 5, busy: false, secret: 'drop' });
  first.open();
  first.message({ type: 'presenterReady' });
  client.publishState({ index: 3, total: 5, busy: true, filename: 'drop.pdf' });
  first.close();
  t.mock.timers.tick(250);

  const second = FakeWebSocket.instances[1];
  assert.ok(second, 'a replacement socket should be created');
  if (!second) return;
  second.open();
  assert.deepEqual(second.sent, [{ type: 'presenter', credential: 'host-secret' }]);
  second.message({ type: 'presenterReady' });
  assert.deepEqual(second.sent, [
    { type: 'presenter', credential: 'host-secret' },
    { type: 'state', index: 3, total: 5, busy: true },
  ]);
  first.message({ type: 'command', id: 'old-socket-command', action: 'next' });
  assert.deepEqual(commands, []);
  client.close();
});

test('replayed command IDs across reconnect reuse saved acknowledgements', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, socket: first, commands } = setup({ autoReconnect: true });
  first.open();
  first.message({ type: 'presenterReady' });
  first.message({ type: 'command', id: 'stable-command', action: 'next' });
  const acknowledgement = { type: 'commandAck', id: 'stable-command', accepted: true };
  assert.deepEqual(first.sent.at(-1), acknowledgement);
  first.close();
  t.mock.timers.tick(250);

  const second = FakeWebSocket.instances[1];
  assert.ok(second, 'a replacement socket should be created');
  if (!second) return;
  second.open();
  second.message({ type: 'presenterReady' });
  second.message({ type: 'command', id: 'stable-command', action: 'next' });
  assert.equal(commands.length, 1);
  assert.deepEqual(second.sent.at(-1), acknowledgement);

  let resolveCommand;
  const deferred = setup({
    autoReconnect: true,
    onCommand: () => new Promise((resolve) => { resolveCommand = resolve; }),
  });
  deferred.socket.open();
  deferred.socket.message({ type: 'presenterReady' });
  const pending = deferred.socket.message({ type: 'command', id: 'pending-command', action: 'next' });
  deferred.socket.close();
  t.mock.timers.tick(250);
  const replacement = FakeWebSocket.instances.at(-1);
  replacement.open();
  replacement.message({ type: 'presenterReady' });
  const duplicate = replacement.message({ type: 'command', id: 'pending-command', action: 'next' });
  assert.equal(deferred.commands.length, 1);
  resolveCommand(true);
  await Promise.all([pending, duplicate]);
  assert.deepEqual(deferred.socket.sent.at(-1), {
    type: 'commandAck', id: 'pending-command', accepted: true,
  });
  assert.deepEqual(replacement.sent.at(-1), deferred.socket.sent.at(-1));
  client.close();
  deferred.client.close();
});

test('retryable and terminal auth outcomes are fenced from stale sockets', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const retry = setup({ autoReconnect: true });
  retry.socket.open();
  retry.socket.message({ type: 'presenterRejected', reason: 'already-connected' });
  t.mock.timers.tick(250);
  assert.equal(FakeWebSocket.instances.length, 2);

  for (const reason of ['invalid-credential', 'session-missing', 'session-ended', 'invalid-session-state']) {
    const attempt = setup({ autoReconnect: true });
    attempt.socket.open();
    attempt.socket.message({ type: 'presenterRejected', reason });
    t.mock.timers.tick(500);
    assert.equal(FakeWebSocket.instances.length, 1, `${reason} should stop retries`);
    attempt.client.close();
  }

  const terminal = setup({ autoReconnect: true });
  terminal.socket.open();
  terminal.socket.message({ type: 'presenterReady' });
  terminal.socket.message({ type: 'sessionEnded' });
  terminal.socket.close();
  t.mock.timers.tick(500);
  assert.equal(FakeWebSocket.instances.length, 1);

  const explicit = setup({ autoReconnect: true });
  const old = explicit.socket;
  const oldMessage = old.onmessage;
  explicit.client.close();
  old.close();
  t.mock.timers.tick(500);
  old.open();
  oldMessage({ data: JSON.stringify({ type: 'presenterReady' }) });
  oldMessage({ data: JSON.stringify({ type: 'command', id: 'late-old', action: 'next' }) });
  await Promise.resolve();
  assert.equal(FakeWebSocket.instances.at(-1), old);
  assert.deepEqual(explicit.commands, []);
});
