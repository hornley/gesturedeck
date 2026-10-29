import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { EventEmitter, once } from 'node:events';
import WebSocket from 'ws';
import { attachRedisCloudRemote } from '../src/cloud-remote-redis-server.js';

const ORIGIN = 'https://gesturedeck.test';
const HOST = 'gesturedeck.test';

class MemoryRedis {
  constructor({ setResults = [], presenterAuthResults = [], presenterAuthStateOverrides = [] } = {}) {
    this.values = new Map();
    this.streams = new Map();
    this.subscribers = new Map();
    this.streamOrdinal = 0;
    this.commandKeys = new Set();
    this.setResults = [...setResults];
    this.setCalls = 0;
    this.presenterAuthResults = [...presenterAuthResults];
    this.presenterAuthStateOverrides = [...presenterAuthStateOverrides];
  }

  async get(key) {
    const value = this.values.get(key);
    return value === undefined ? null : structuredClone(value);
  }

  async set(key, value, options = {}) {
    this.setCalls += 1;
    if (this.setResults.length) {
      const result = this.setResults.shift();
      if (result !== 'OK') return result;
    }
    if (options.nx && this.values.has(key)) return null;
    this.values.set(key, structuredClone(value));
    return 'OK';
  }

  async del(...keys) {
    return keys.reduce((removed, key) => removed + Number(this.values.delete(key)), 0);
  }

  subscribe(channel) {
    const subscriber = new EventEmitter();
    const listeners = this.subscribers.get(channel) ?? new Set();
    listeners.add(subscriber);
    this.subscribers.set(channel, listeners);
    subscriber.unsubscribe = async () => {
      listeners.delete(subscriber);
      if (listeners.size === 0) this.subscribers.delete(channel);
    };
    queueMicrotask(() => subscriber.emit('subscribe', channel, listeners.size));
    return subscriber;
  }

  async xrevrange(key) {
    const entries = this.streams.get(key) ?? [];
    const last = entries.at(-1);
    return last ? [[last.id, ['data', JSON.stringify(last.message)]]] : [];
  }

  async eval(script, keys, args) {
    const operation = script.match(/REDIS_OP:([A-Z_]+)/)?.[1];
    if (operation === 'PRESENTER_AUTH') {
      if (this.presenterAuthResults.length) return this.presenterAuthResults.shift();
      const session = this.values.get(keys[0]);
      if (!session) return JSON.stringify({ status: 'missing' });
      if (!session.active) return JSON.stringify({ status: 'ended' });
      if (session.hostCredential !== args[0]) return JSON.stringify({ status: 'invalid' });
      let state = session.state;
      if (state?.target === 'canva') {
        const allowed = new Set(['target', 'ready', 'busy', 'index', 'total']);
        if (Object.keys(state).some((field) => !allowed.has(field))
          || typeof state.ready !== 'boolean' || state.busy !== false
          || state.index !== undefined && state.index !== null
          || state.total !== undefined && state.total !== null) {
          return JSON.stringify({ status: 'invalid-state' });
        }
        state = { target: 'canva', ready: state.ready, index: null, total: null, busy: false };
        session.state = state;
        this.values.set(keys[0], session);
      }
      if (this.values.has(keys[1])) return JSON.stringify({ status: 'occupied' });
      this.values.set(keys[1], args[1]);
      this.values.delete(keys[4]);
      this.#publish(keys[2], keys[3], { type: 'state', ...state });
      return JSON.stringify({
        status: 'ok',
        state: this.presenterAuthStateOverrides.shift() ?? state,
      });
    }

    if (operation === 'RENEW_INVITE') {
      const session = this.values.get(keys[0]);
      const now = Date.now();
      if (!session?.active || Number(session.expiresAt ?? 0) <= now
        || session.hostCredential !== args[0] || session.origin !== args[1]) return 'unavailable';
      session.invite = args[2];
      session.inviteExpiresAt = now + Number(args[3]);
      session.pairAttempts = 0;
      session.inviteExpiredNotified = false;
      this.values.set(keys[0], session);
      return JSON.stringify({ origin: session.origin, invite: session.invite, inviteExpiresAt: session.inviteExpiresAt });
    }

    if (operation === 'PHONE_PAIR') {
      const session = this.values.get(keys[0]);
      if (!session) return 'missing';
      if (!session.active) return 'ended';
      if (!this.values.has(keys[1])) return 'host-unavailable';
      if (session.inviteExpiresAt < Number(args[2])) return 'expired';
      if (args[0] === '' || (session.pairAttempts ?? 0) >= 5) return 'invalid';
      if (session.invite !== args[0]) {
        session.pairAttempts = (session.pairAttempts ?? 0) + 1;
        if (session.pairAttempts >= 5) session.invite = '';
        return 'invalid';
      }
      const phones = session.phones ?? {};
      if (session.phoneCredential && Object.keys(phones).length === 0) {
        phones[session.phoneId ?? session.phoneCredential] = {
          phoneId: session.phoneId ?? session.phoneCredential,
          credential: session.phoneCredential,
          label: session.phoneLabel ?? 'Phone',
          deviceType: session.phoneDeviceType ?? 'phone',
          ordinal: 0,
        };
      }
      if (Object.keys(phones).length >= Number(args[9])) return 'session-full';
      const ordinal = Math.max(session.nextPhoneOrdinal ?? 1, Object.keys(phones).length + 1);
      const typeLabels = { iphone: 'iPhone', 'android-phone': 'Android phone', phone: 'Phone' };
      const base = args[7] || `${typeLabels[args[8]] ?? 'Phone'} ${ordinal}`;
      let label = base;
      let suffix = 2;
      while (Object.values(phones).some((phone) => phone.label.toLowerCase() === label.toLowerCase())) {
        label = `${base} (${suffix})`;
        suffix += 1;
      }
      const identity = { phoneId: args[6], label, deviceType: args[8] };
      phones[identity.phoneId] = { ...identity, credential: args[1], ordinal };
      session.phones = phones;
      session.nextPhoneOrdinal = ordinal + 1;
      delete session.phoneCredential;
      this.values.set(keys[0], session);
      this.values.set(keys[2], args[3]);
      return JSON.stringify({ ...identity, state: session.state });
    }

    if (operation === 'PHONE_RESUME') {
      const session = this.values.get(keys[0]);
      if (!session?.active) return 'invalid';
      const phones = session.phones ?? {};
      let phone = Object.values(phones).find((item) => item.credential === args[0]);
      if (!phone && session.phoneCredential === args[0]) {
        const phoneId = session.phoneId ?? session.phoneCredential;
        phone = {
          phoneId, credential: args[0], label: session.phoneLabel ?? 'Phone',
          deviceType: session.phoneDeviceType ?? 'phone', ordinal: 0,
        };
        phones[phoneId] = phone;
        session.phones = phones;
        delete session.phoneCredential;
        this.values.set(keys[0], session);
      }
      if (!phone) return 'invalid';
      this.values.set(keys[1], args[1]);
      this.values.delete(keys[2]);
      const latest = this.streams.get(keys[3])?.at(-1);
      const cursor = latest?.id ?? '0-0';
      return JSON.stringify({ phoneId: phone.phoneId, label: phone.label, deviceType: phone.deviceType, state: session.state, cursor });
    }

    if (operation === 'PHONE_COMMAND') {
      const session = this.values.get(keys[0]);
      const paired = Object.values(session?.phones ?? {}).some((phone) => phone.credential === args[0]);
      const legacy = !paired && session?.phoneCredential === args[0];
      const leaseKey = legacy ? keys[5] : keys[4];
      if (!session?.active || (!paired && !legacy)) return 'invalid';
      if (this.values.get(leaseKey) !== args[6]) return 'invalid';
      const readyOwner = this.values.get(keys[6]);
      if (!readyOwner || this.values.get(keys[7]) !== readyOwner) return 'unavailable';
      if (session.state.target === 'canva' && session.state.ready !== true) return 'not-ready';
      if (args[1] === 'goTo'
        && (session.state.target === 'canva' || Number(args[2]) >= session.state.total)) return 'out-of-range';
      if (this.commandKeys.has(keys[1])) return 'duplicate';
      this.commandKeys.add(keys[1]);
      if (args[5] === '1') this.#publish(keys[2], keys[3], JSON.parse(args[4]));
      return 'ok';
    }

    if (operation === 'REMOVE_PHONE') {
      if (args[5] && this.values.get(keys[2]) !== args[5]) return 'replaced';
      const session = this.values.get(keys[0]);
      if (!session) return 'missing-session';
      if (args[5] && !session.active) return 'ended';
      const phones = session.phones ?? {};
      let phone = phones[args[0]];
      let legacy = false;
      if (!phone && session.phoneCredential && (session.phoneId ?? session.phoneCredential) === args[0]) {
        phone = { phoneId: args[0], credential: session.phoneCredential };
        legacy = true;
      }
      if (!phone || (args[1] !== '' && phone.credential !== args[1])) return 'missing';
      if (args[4]) {
        const leaseKey = legacy ? keys[1] : `${args[2]}${phone.credential}`;
        if (this.values.get(leaseKey) !== args[4]) return 'missing';
      }
      if (legacy) {
        this.values.delete(keys[1]);
        delete session.phoneCredential;
        delete session.phoneId;
        delete session.phoneLabel;
        delete session.phoneDeviceType;
      }
      delete phones[args[0]];
      session.phones = phones;
      this.values.set(keys[0], session);
      this.values.delete(`${args[2]}${phone.credential}`);
      if (args[5]) {
        this.#publish(keys[3], keys[4], { type: 'sessionEnded', phoneId: args[0] });
        const visible = Object.entries(phones).map(([phoneId, record]) => ({
          phoneId,
          label: record.label || 'Phone',
          deviceType: record.deviceType || 'phone',
          status: this.values.has(`${args[2]}${record.credential}`) ? 'connected' : 'reconnecting',
          ordinal: Number(record.ordinal) || 0,
        })).sort((left, right) => left.ordinal - right.ordinal || left.phoneId.localeCompare(right.phoneId))
          .map((record) => {
            delete record.ordinal;
            return record;
          });
        this.#emit(keys[5], { type: 'phones', phones: visible }, args[7]);
      }
      return 'removed';
    }

    if (operation === 'END_SESSION') {
      const session = this.values.get(keys[0]);
      if (!session?.active) return 0;
      session.active = false;
      session.invite = '';
      session.inviteExpiresAt = 0;
      for (const phone of Object.values(session.phones ?? {})) this.values.delete(`${args[0]}${phone.credential}`);
      if (session.phoneCredential) this.values.delete(keys[1]);
      delete session.phoneCredential;
      this.values.set(keys[0], session);
      return 1;
    }

    if (operation === 'UPDATE_STATE') {
      if (this.values.get(keys[1]) !== args[2]) return 'replaced';
      const session = this.values.get(keys[0]);
      if (!session) return 'missing';
      if (!session.active) return 'ended';
      if (Number(session.expiresAt ?? 0) <= Number(args[1])) return 'ended';
      const wasReady = this.values.get(keys[4]) === args[2];
      this.values.set(keys[4], args[2]);
      session.state = JSON.parse(args[0]);
      this.values.set(keys[0], session);
      this.#publish(keys[2], keys[3], { type: 'state', ...session.state });
      if (!wasReady) this.#publish(keys[2], keys[3], { type: 'presenterStatus', available: true });
      return 'ok';
    }

    if (operation === 'PRESENTER_ACK') {
      if (this.values.get(keys[1]) !== args[0]) return 'replaced';
      const session = this.values.get(keys[0]);
      if (!session) return 'missing';
      if (!session.active) return 'ended';
      this.#publish(keys[2], keys[3], JSON.parse(args[1]));
      return 'ok';
    }

    if (operation === 'PRESENTER_EVENT') {
      if (this.values.get(keys[1]) !== args[0]) return 'replaced';
      const session = this.values.get(keys[0]);
      if (!session) return 'missing';
      if (!session.active) return 'ended';
      this.#emit(keys[2], JSON.parse(args[1]), args[2]);
      return 'ok';
    }

    if (operation === 'POLL_SESSION') {
      const session = this.values.get(keys[0]);
      if (!session) return ['missing'];
      if (!session.active) return ['ended'];
      if (this.values.get(keys[1]) !== args[0]) return ['replaced'];
      if (args[4] === '1' && session.inviteExpiresAt > 0 && Number(args[2]) >= session.inviteExpiresAt
        && !session.inviteExpiredNotified) {
        session.inviteExpiredNotified = true;
        this.values.set(keys[0], session);
      }
      const events = (this.streams.get(keys[2]) ?? []).filter((entry) => entry.id > args[3]);
      const streams = events.length
        ? [[keys[2], events.map(({ id, message }) => [id, ['data', JSON.stringify(message)]])]]
        : [];
      return ['ok', JSON.stringify(session), JSON.stringify(streams), session.inviteExpiredNotified ? '1' : '0',
        this.values.get(keys[3]) && this.values.get(keys[3]) === this.values.get(keys[4]) ? '1' : '0'];
    }

    if (operation === 'PUBLISH_EVENT') {
      const message = JSON.parse(args[0]);
      return this.#publish(keys[0], keys[1], message);
    }

    if (operation === 'RELEASE_PRESENTER') {
      let released = 0;
      if (this.values.get(keys[1]) === args[0]) {
        this.values.delete(keys[1]);
        released = 1;
      }
      if (this.values.get(keys[2]) === args[0]) {
        this.values.delete(keys[2]);
        released = 1;
        if (this.values.get(keys[0])?.active) {
          this.#publish(keys[3], keys[4], { type: 'presenterStatus', available: false });
        }
      }
      return released;
    }

    if (operation === 'RELEASE_PHONE') {
      if (this.values.get(keys[0]) !== args[0]) return 0;
      this.values.delete(keys[0]);
      return 1;
    }

    throw new Error(`Fake Redis received unsupported script operation: ${operation}`);
  }

  #publish(streamKey, channel, message) {
    const entries = this.streams.get(streamKey) ?? [];
    const id = `${++this.streamOrdinal}-0`;
    entries.push({ id, message: structuredClone(message) });
    this.streams.set(streamKey, entries);
    this.#emit(channel, message, id);
    return id;
  }

  #emit(channel, message, eventId) {
    const envelope = { eventId, message: structuredClone(message) };
    for (const subscriber of this.subscribers.get(channel) ?? []) {
      queueMicrotask(() => subscriber.emit('message', { message: envelope }));
    }
  }
}

class Peer {
  constructor(socket) {
    this.socket = socket;
    this.messages = [];
    this.waiters = [];
    this.closed = undefined;
    socket.on('close', (code, reason) => { this.closed = [code, reason.toString('utf8')]; });
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString('utf8'));
      this.messages.push(message);
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(message)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        }
      }
    });
  }

  send(message) { this.socket.send(JSON.stringify(message)); }

  waitFor(type, predicate = () => true, timeoutMs = 3_000) {
    const index = this.messages.findIndex((message) => message.type === type && predicate(message));
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate: (message) => message.type === type && predicate(message),
        resolve,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          reject(new Error(`Timed out waiting for ${type}; received ${JSON.stringify(this.messages)}, readyState ${this.socket.readyState}, closed ${JSON.stringify(this.closed)}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = once(this.socket, 'close');
    this.socket.close(1000, 'test cleanup');
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 500))]);
  }
}

async function connectPeer(port, sessionId, route) {
  const target = `ws://127.0.0.1:${port}/api/cloud-remote-ws?__gd_route=${route}&session=${sessionId}`;
  const socket = new WebSocket(target, { origin: ORIGIN, headers: { host: HOST } });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return new Peer(socket);
}

async function postCloudRoute(port, route, body) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: `/api/cloud-remote?__gd_route=${route}`,
      method: 'POST',
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

async function createFixture({
  redis = new MemoryRedis(),
  state = { index: 0, total: 12, busy: false },
  expectedStartStatus = 200,
} = {}) {
  const server = createServer();
  const relay = attachRedisCloudRemote(server, { redis, webSocketFunctionPath: '/api/cloud-remote-ws' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const peers = new Set();

  const pairingResponse = await postCloudRoute(server.address().port, 'start', {
    state,
  });
  assert.equal(pairingResponse.status, expectedStartStatus);
  const pairing = pairingResponse.status === 200 ? pairingResponse.body : null;

  async function connect(route) {
    assert.ok(pairing, 'a successful session start is required before connecting a peer');
    const peer = await connectPeer(server.address().port, pairing.sessionId, route);
    peers.add(peer);
    return peer;
  }

  async function presenter() {
    const peer = await connect('presenter');
    peer.send({ type: 'presenter', credential: pairing.hostCredential });
    await peer.waitFor('presenterReady');
    peer.send({ type: 'state', ...state });
    await peer.waitFor('phones', (message) => message.phones.length === 0);
    return peer;
  }

  async function pairPhone(presenterPeer, metadata = {}) {
    const peer = await connect('phone');
    peer.send({ type: 'pair', invite: pairing.fallbackUrl.split('#')[1], nickname: '', deviceType: 'phone', ...metadata });
    const paired = await peer.waitFor('paired');
    if (presenterPeer) await presenterPeer.waitFor('phones', (message) => message.phones.some((phone) => phone.phoneId === paired.phoneId));
    return { peer, paired };
  }

  return {
    redis, server, relay, pairing, pairingResponse, peers, connect, presenter, pairPhone,
    async close() {
      await Promise.all([...peers].map((peer) => peer.close()));
      await relay.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function rejectPresenterAuth(fixture, credential = fixture.pairing.hostCredential) {
  const peer = await fixture.connect('presenter');
  peer.send({ type: 'presenter', credential });
  return peer.waitFor('presenterRejected');
}

test('hosted Redis WebSocket close logs identify the endpoint and safe close details', async (t) => {
  const logs = [];
  const closeLogs = new EventEmitter();
  t.mock.method(console, 'info', (message) => {
    logs.push(message);
    closeLogs.emit('close', message);
  });
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const presenter = await fixture.presenter();
  const phone = await fixture.pairPhone(presenter);

  const phoneLogPromise = once(closeLogs, 'close');
  const phoneClosed = once(phone.peer.socket, 'close');
  phone.peer.socket.close(1001, 'hotspot\r\ninterruption');
  await phoneClosed;
  const [phoneLog] = await phoneLogPromise;
  const phonePrefix = '[cloud-remote] phone WebSocket closed ';
  assert.ok(phoneLog.startsWith(phonePrefix));
  assert.deepEqual(JSON.parse(phoneLog.slice(phonePrefix.length)), {
    code: 1001, reason: 'hotspot\r\ninterruption',
  });
  assert.doesNotMatch(phoneLog, /[\r\n]/);
  assert.equal([
    fixture.pairing.hostCredential, phone.paired.credential,
    phone.paired.phoneId, phone.paired.label,
  ].some((secret) => phoneLog.includes(secret)), false);

  const presenterLogPromise = once(closeLogs, 'close');
  const presenterClosed = once(presenter.socket, 'close');
  presenter.socket.close(1000, 'presenter closed');
  await presenterClosed;
  const [presenterLog] = await presenterLogPromise;
  const presenterPrefix = '[cloud-remote] presenter WebSocket closed ';
  assert.ok(presenterLog.startsWith(presenterPrefix));
  assert.deepEqual(JSON.parse(presenterLog.slice(presenterPrefix.length)), {
    code: 1000, reason: 'presenter closed',
  });
});

test('hosted Redis relay authenticates fresh Canva sessions and canonicalizes Redis state', async (t) => {
  const cases = [
    {
      ready: false,
      authState: { target: 'canva', ready: false, index: null, total: null, busy: false },
    },
    {
      ready: true,
      authState: { target: 'canva', ready: true, busy: false },
    },
  ];

  for (const scenario of cases) {
    const fixture = await createFixture({
      state: { target: 'canva', ready: scenario.ready, index: null, total: null, busy: false },
    });
    fixture.redis.presenterAuthStateOverrides.push(scenario.authState);
    t.after(() => fixture.close());

    const presenter = await fixture.presenter();
    const phone = await fixture.pairPhone(presenter);
    const expectedState = {
      target: 'canva', ready: scenario.ready, index: null, total: null, busy: false,
    };
    assert.deepEqual(phone.paired.state, expectedState);
    assert.deepEqual(await phone.peer.waitFor('state'), { type: 'state', ...expectedState });
  }
});

test('hosted Redis relay canonicalizes omitted Canva slide fields returned during phone pairing', async (t) => {
  const fixture = await createFixture({
    state: { target: 'canva', ready: true, index: null, total: null, busy: false },
  });
  t.after(() => fixture.close());
  const presenter = await fixture.presenter();
  const evalRedis = fixture.redis.eval.bind(fixture.redis);
  fixture.redis.eval = async (script, keys, args) => {
    const result = await evalRedis(script, keys, args);
    if (!script.includes('-- REDIS_OP:PHONE_PAIR') || typeof result !== 'string' || !result.startsWith('{')) {
      return result;
    }
    const parsed = JSON.parse(result);
    delete parsed.state.index;
    delete parsed.state.total;
    return JSON.stringify(parsed);
  };

  const phone = await fixture.pairPhone(presenter);

  assert.deepEqual(phone.paired.state, {
    target: 'canva', ready: true, index: null, total: null, busy: false,
  });
});

test('hosted Redis relay keeps presenter authentication outcomes distinct and safe', async (t) => {
  const cases = [
    {
      name: 'missing session',
      reason: 'session-missing',
      prepare: async (fixture) => fixture.redis.del(`gesturedeck:${fixture.pairing.sessionId}`),
    },
    {
      name: 'ended session',
      reason: 'session-ended',
      prepare: async (fixture) => {
        const key = `gesturedeck:${fixture.pairing.sessionId}`;
        const session = await fixture.redis.get(key);
        session.active = false;
        await fixture.redis.set(key, session);
      },
    },
    {
      name: 'credential mismatch',
      reason: 'invalid-credential',
      credential: 'wrong-credential',
    },
    {
      name: 'occupied presenter lease',
      reason: 'already-connected',
      prepare: (fixture) => fixture.redis.set(
        `gesturedeck:${fixture.pairing.sessionId}:presenter-lease`, 'another-presenter',
      ),
    },
    {
      name: 'invalid Redis state status',
      reason: 'invalid-session-state',
      prepare: async (fixture) => {
        const key = `gesturedeck:${fixture.pairing.sessionId}`;
        const session = await fixture.redis.get(key);
        session.state = { target: 'canva', ready: true, index: 3, total: 12, busy: false };
        await fixture.redis.set(key, session);
      },
    },
    {
      name: 'invalid serialized state',
      reason: 'invalid-session-state',
      prepare: (fixture) => fixture.redis.presenterAuthResults.push(JSON.stringify({
        status: 'ok',
        state: { target: 'canva', ready: true, index: 3, total: 12, busy: false },
      })),
    },
    {
      name: 'malformed Redis result',
      reason: 'invalid-session-state',
      prepare: (fixture) => fixture.redis.presenterAuthResults.push('untrusted Redis output'),
    },
  ];

  for (const scenario of cases) {
    const fixture = await createFixture();
    t.after(() => fixture.close());
    await scenario.prepare?.(fixture);

    const rejection = await rejectPresenterAuth(fixture, scenario.credential);
    assert.deepEqual(rejection, { type: 'presenterRejected', reason: scenario.reason }, scenario.name);
  }
});

test('hosted Redis relay retries a colliding session ID before returning credentials', async (t) => {
  const redis = new MemoryRedis({ setResults: [null, 'OK'] });
  const fixture = await createFixture({ redis });
  t.after(() => fixture.close());

  assert.equal(redis.setCalls, 2);
  assert.ok(redis.values.has(`gesturedeck:${fixture.pairing.sessionId}`));
  assert.equal(typeof fixture.pairing.hostCredential, 'string');
});

test('hosted Redis relay with no successful SET NX result returns no session credentials', async (t) => {
  const redis = new MemoryRedis({ setResults: [null, null, null] });
  const fixture = await createFixture({ redis, expectedStartStatus: 503 });
  t.after(() => fixture.close());

  assert.equal(redis.setCalls, 3);
  assert.deepEqual(fixture.pairingResponse.body, { error: 'relay-storage-unavailable' });
  assert.equal(fixture.pairing, null);
  assert.equal(redis.values.size, 0);
});

test('hosted Redis relay pairs multiple phones, broadcasts state, and routes acknowledgements to the source', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const presenter = await fixture.presenter();
  const first = await fixture.pairPhone(presenter, { nickname: 'Alex', deviceType: 'iphone' });
  const second = await fixture.pairPhone(presenter, { nickname: 'Alex', deviceType: 'android-phone' });

  assert.equal(first.paired.label, 'Alex');
  assert.equal(second.paired.label, 'Alex (2)');
  assert.notEqual(first.paired.phoneId, second.paired.phoneId);

  presenter.send({ type: 'state', index: 3, total: 12, busy: false });
  assert.deepEqual(await first.peer.waitFor('state', (message) => message.index === 3), {
    type: 'state', index: 3, total: 12, busy: false,
  });
  assert.deepEqual(await second.peer.waitFor('state', (message) => message.index === 3), {
    type: 'state', index: 3, total: 12, busy: false,
  });

  first.peer.send({ type: 'command', id: 'first-command', action: 'next' });
  const forwarded = await presenter.waitFor('command');
  assert.match(forwarded.id, new RegExp(`^${first.paired.phoneId}\\.first-command$`));
  presenter.send({ type: 'commandAck', id: forwarded.id, accepted: true });
  assert.deepEqual(await first.peer.waitFor('commandAck'), {
    type: 'commandAck', id: 'first-command', accepted: true,
  });
  assert.equal(second.peer.messages.some((message) => message.type === 'commandAck'), false);
});

test('hosted Redis relay preserves the session and phone identity after presenter close', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const presenter = await fixture.presenter();
  const { peer: phone, paired } = await fixture.pairPhone(presenter, { nickname: 'Alex' });
  assert.deepEqual(await phone.waitFor('presenterStatus'), { type: 'presenterStatus', available: true });

  await presenter.close();
  assert.deepEqual(await phone.waitFor('presenterStatus'), { type: 'presenterStatus', available: false });
  assert.equal((await fixture.redis.get(`gesturedeck:${fixture.pairing.sessionId}`)).active, true);
  assert.equal(presenter.messages.some((message) => message.type === 'sessionEnded'), false);
  assert.equal(phone.messages.some((message) => message.type === 'sessionEnded'), false);

  await phone.close();
  const resumed = await fixture.connect('phone');
  resumed.send({ type: 'resume', credential: paired.credential });
  assert.deepEqual(await resumed.waitFor('resumed'), {
    type: 'resumed', phoneId: paired.phoneId, label: 'Alex', deviceType: 'phone',
    state: { index: 0, total: 12, busy: false },
  });
  assert.deepEqual(await resumed.waitFor('presenterStatus'), { type: 'presenterStatus', available: false });
  resumed.send({ type: 'command', id: 'unavailable', action: 'next' });
  assert.deepEqual(await resumed.waitFor('commandAck', (message) => message.id === 'unavailable'), {
    type: 'commandAck', id: 'unavailable', accepted: false,
  });
  assert.equal(fixture.redis.commandKeys.has(`gesturedeck:${fixture.pairing.sessionId}:command:${paired.phoneId}:unavailable`), false);

  const sessionKey = `gesturedeck:${fixture.pairing.sessionId}`;
  await fixture.redis.eval('-- REDIS_OP:PUBLISH_EVENT',
    [`${sessionKey}:to-presenter`, `${sessionKey}:presenter-events`],
    [JSON.stringify({ type: 'command', id: `${paired.phoneId}.old`, action: 'next' }), '14400']);
  const replacement = await fixture.connect('presenter');
  replacement.send({ type: 'presenter', credential: fixture.pairing.hostCredential });
  await replacement.waitFor('presenterReady');
  replacement.send({ type: 'state', index: 2, total: 12, busy: false });
  assert.deepEqual(await resumed.waitFor('presenterStatus', (message) => message.available), {
    type: 'presenterStatus', available: true,
  });
  resumed.send({ type: 'command', id: 'new', action: 'next' });
  assert.deepEqual(await replacement.waitFor('command', (message) => message.id.endsWith('.new')), {
    type: 'command', id: `${paired.phoneId}.new`, action: 'next',
  });
  assert.equal(replacement.messages.some((message) => message.type === 'command' && message.id.endsWith('.old')), false);

  await fixture.redis.del(`${sessionKey}:presenter-ready`);
  assert.deepEqual(await resumed.waitFor('presenterStatus', (message) => !message.available, 6_000), {
    type: 'presenterStatus', available: false,
  });
});

test('hosted Redis relay keeps explicit stop terminal', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const presenter = await fixture.presenter();
  const { peer: phone, paired } = await fixture.pairPhone(presenter);
  await phone.waitFor('presenterStatus', (message) => message.available);

  const stopped = await postCloudRoute(fixture.server.address().port, 'stop', {
    sessionId: fixture.pairing.sessionId,
    hostCredential: fixture.pairing.hostCredential,
  });
  assert.equal(stopped.status, 200);
  assert.deepEqual(await phone.waitFor('sessionEnded'), { type: 'sessionEnded' });
  assert.deepEqual(await presenter.waitFor('sessionEnded'), { type: 'sessionEnded' });
  assert.equal((await fixture.redis.get(`gesturedeck:${fixture.pairing.sessionId}`)).active, false);
  assert.equal(await fixture.redis.get(`gesturedeck:${fixture.pairing.sessionId}:presenter-lease`), null);
  assert.equal(await fixture.redis.get(`gesturedeck:${fixture.pairing.sessionId}:presenter-ready`), null);

  const retry = await fixture.connect('phone');
  retry.send({ type: 'resume', credential: paired.credential });
  assert.deepEqual(await retry.waitFor('resumeRejected'), { type: 'resumeRejected', reason: 'invalid' });
});

test('hosted Redis relay rejects commands when readiness outlives the presenter lease', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const presenter = await fixture.presenter();
  const { peer: phone, paired } = await fixture.pairPhone(presenter);
  await phone.waitFor('presenterStatus', (message) => message.available);
  const sessionKey = `gesturedeck:${fixture.pairing.sessionId}`;
  await fixture.redis.del(`${sessionKey}:presenter-lease`);
  assert.ok(await fixture.redis.get(`${sessionKey}:presenter-ready`));

  phone.send({ type: 'command', id: 'orphaned-ready', action: 'next' });
  assert.deepEqual(await phone.waitFor('commandAck', (message) => message.id === 'orphaned-ready'), {
    type: 'commandAck', id: 'orphaned-ready', accepted: false,
  });
  assert.equal(fixture.redis.commandKeys.has(`${sessionKey}:command:${paired.phoneId}:orphaned-ready`), false);
  assert.equal(presenter.messages.some((message) => message.type === 'command'
    && message.id.endsWith('.orphaned-ready')), false);

  await phone.close();
  const resumed = await fixture.connect('phone');
  resumed.send({ type: 'resume', credential: paired.credential });
  await resumed.waitFor('resumed');
  assert.deepEqual(await resumed.waitFor('presenterStatus'), { type: 'presenterStatus', available: false });
  const evalRedis = fixture.redis.eval.bind(fixture.redis);
  let finishRelease;
  const released = new Promise((resolve) => { finishRelease = resolve; });
  fixture.redis.eval = async (script, keys, args) => {
    const result = await evalRedis(script, keys, args);
    if (script.includes('-- REDIS_OP:RELEASE_PRESENTER')) finishRelease();
    return result;
  };
  await presenter.close();
  await released;
  assert.equal(await fixture.redis.get(`${sessionKey}:presenter-ready`), null);
  assert.equal((await fixture.redis.get(sessionKey)).active, true);
});

test('hosted Redis relay ignores a stale phone poll after presenter disconnect', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const presenter = await fixture.presenter();
  const evalRedis = fixture.redis.eval.bind(fixture.redis);
  let capturePoll;
  let releasePoll;
  const pollCaptured = new Promise((resolve) => { capturePoll = resolve; });
  const pollGate = new Promise((resolve) => { releasePoll = resolve; });
  let held = false;
  fixture.redis.eval = async (script, keys, args) => {
    const result = await evalRedis(script, keys, args);
    if (!held && script.includes('-- REDIS_OP:POLL_SESSION') && args[5] === '0') {
      held = true;
      capturePoll();
      await pollGate;
    }
    return result;
  };
  const { peer: phone } = await fixture.pairPhone(presenter);
  await phone.waitFor('presenterStatus', (message) => message.available);
  await pollCaptured;

  await presenter.close();
  assert.deepEqual(await phone.waitFor('presenterStatus', (message) => !message.available), {
    type: 'presenterStatus', available: false,
  });
  releasePoll();
  await assert.rejects(phone.waitFor('presenterStatus', (message) => message.available, 100),
    /Timed out waiting for presenterStatus/);
});

test('hosted Redis relay ignores a stale initial availability read after presenter disconnect', async () => {
  for (const mode of ['pair', 'resume']) {
    const fixture = await createFixture();
    let releaseRead = () => {};
    let readTimeout;
    try {
      const presenter = await fixture.presenter();
      let credential;
      if (mode === 'resume') {
        const previous = await fixture.pairPhone(presenter);
        await previous.peer.waitFor('presenterStatus', (message) => message.available);
        credential = previous.paired.credential;
        await previous.peer.close();
      }
      const sessionKey = `gesturedeck:${fixture.pairing.sessionId}`;
      const redisGet = fixture.redis.get.bind(fixture.redis);
      let captureRead;
      const readCaptured = new Promise((resolve) => { captureRead = resolve; });
      const readGate = new Promise((resolve) => { releaseRead = resolve; });
      fixture.redis.get = async (key) => {
        const value = await redisGet(key);
        if (captureRead && key === `${sessionKey}:presenter-ready`) {
          const captured = captureRead;
          captureRead = null;
          captured();
          await readGate;
        }
        return value;
      };

      const phone = await fixture.connect('phone');
      phone.send(mode === 'pair'
        ? { type: 'pair', invite: fixture.pairing.fallbackUrl.split('#')[1], deviceType: 'phone' }
        : { type: 'resume', credential });
      await phone.waitFor(mode === 'pair' ? 'paired' : 'resumed');
      await Promise.race([readCaptured, new Promise((_, reject) => {
        readTimeout = setTimeout(() => reject(new Error(`Timed out waiting for ${mode} availability read`)), 3_000);
      })]);
      await presenter.close();
      assert.deepEqual(await phone.waitFor('presenterStatus', (message) => !message.available), {
        type: 'presenterStatus', available: false,
      }, mode);
      releaseRead();
      await assert.rejects(phone.waitFor('presenterStatus', (message) => message.available, 100),
        /Timed out waiting for presenterStatus/, mode);
    } finally {
      clearTimeout(readTimeout);
      releaseRead();
      await fixture.close();
    }
  }
});

test('hosted Redis relay rejects Canva commands until the target is ready', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const presenter = await fixture.presenter();
  const phone = await fixture.pairPhone(presenter);

  presenter.send({ type: 'state', target: 'canva', ready: false, index: null, total: null, busy: false });
  await phone.peer.waitFor('state', (message) => message.target === 'canva');
  phone.peer.send({ type: 'command', id: 'canva-not-ready', action: 'next' });

  await assert.rejects(
    presenter.waitFor('command', (message) => message.id.endsWith('.canva-not-ready'), 100),
    /Timed out waiting for command/,
  );
  assert.deepEqual(await phone.peer.waitFor('commandAck'), {
    type: 'commandAck', id: 'canva-not-ready', accepted: false,
  });
});

test('hosted Redis relay routes phone lists, state, commands, and acknowledgements across function instances', async (t) => {
  const fixture = await createFixture();
  const secondServer = createServer();
  const secondRelay = attachRedisCloudRemote(secondServer, {
    redis: fixture.redis,
    webSocketFunctionPath: '/api/cloud-remote-ws',
  });
  await new Promise((resolve) => secondServer.listen(0, '127.0.0.1', resolve));
  const remotePeers = new Set();
  t.after(async () => {
    await Promise.all([...remotePeers].map((peer) => peer.close()));
    await secondRelay.close();
    await new Promise((resolve) => secondServer.close(resolve));
    await fixture.close();
  });

  const presenter = await fixture.presenter();
  const first = await connectPeer(secondServer.address().port, fixture.pairing.sessionId, 'phone');
  const second = await connectPeer(secondServer.address().port, fixture.pairing.sessionId, 'phone');
  remotePeers.add(first);
  remotePeers.add(second);
  first.send({
    type: 'pair', invite: fixture.pairing.fallbackUrl.split('#')[1], nickname: 'Riley', deviceType: 'iphone',
  });
  const firstPaired = await first.waitFor('paired');
  await presenter.waitFor('phones', (message) => message.phones.some((phone) => phone.phoneId === firstPaired.phoneId));
  second.send({
    type: 'pair', invite: fixture.pairing.fallbackUrl.split('#')[1], nickname: 'Morgan', deviceType: 'phone',
  });
  const secondPaired = await second.waitFor('paired');
  await presenter.waitFor('phones', (message) => message.phones.length === 2);

  presenter.send({ type: 'state', index: 4, total: 12, busy: false });
  assert.deepEqual(await first.waitFor('state', (message) => message.index === 4), {
    type: 'state', index: 4, total: 12, busy: false,
  });
  assert.deepEqual(await second.waitFor('state', (message) => message.index === 4), {
    type: 'state', index: 4, total: 12, busy: false,
  });

  first.send({ type: 'command', id: 'cross-instance', action: 'next' });
  const forwarded = await presenter.waitFor('command', (message) => message.id.endsWith('.cross-instance'));
  presenter.send({ type: 'commandAck', id: forwarded.id, accepted: true });
  assert.deepEqual(await first.waitFor('commandAck'), {
    type: 'commandAck', id: 'cross-instance', accepted: true,
  });
  await assert.rejects(second.waitFor('commandAck', () => true, 100), /Timed out waiting for commandAck/);
  assert.notEqual(firstPaired.phoneId, secondPaired.phoneId);
});

test('hosted Redis relay resumes a phone identity and removes phones individually', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const presenter = await fixture.presenter();
  const first = await fixture.pairPhone(presenter, { nickname: 'Pat', deviceType: 'iphone' });
  const second = await fixture.pairPhone(presenter, { nickname: 'Sam', deviceType: 'phone' });

  await first.peer.close();
  const reconnecting = await presenter.waitFor('phones', (message) =>
    message.phones.some((phone) => phone.phoneId === first.paired.phoneId && phone.status === 'reconnecting'));
  assert.equal(reconnecting.phones.length, 2);

  const resumed = await fixture.connect('phone');
  resumed.send({ type: 'resume', credential: first.paired.credential });
  assert.deepEqual(await resumed.waitFor('resumed'), {
    type: 'resumed', phoneId: first.paired.phoneId, label: 'Pat', deviceType: 'iphone',
    state: { index: 0, total: 12, busy: false },
  });
  await presenter.waitFor('phones', (message) =>
    message.phones.some((phone) => phone.phoneId === first.paired.phoneId && phone.status === 'connected'));

  presenter.send({ type: 'removePhone', phoneId: first.paired.phoneId });
  assert.deepEqual(await resumed.waitFor('sessionEnded'), { type: 'sessionEnded' });
  const remaining = await presenter.waitFor('phones', (message) =>
    message.phones.length === 1 && message.phones[0].phoneId === second.paired.phoneId);
  assert.equal(remaining.phones[0].status, 'connected');

  second.peer.send({ type: 'disconnect' });
  await presenter.waitFor('phones', (message) => message.phones.length === 0);
  assert.equal(fixture.redis.values.get(`gesturedeck:${fixture.pairing.sessionId}`).active, true);
});

test('hosted Redis relay migrates a legacy single-phone session before pairing another phone', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const presenter = await fixture.presenter();
  const sessionKey = `gesturedeck:${fixture.pairing.sessionId}`;
  const session = await fixture.redis.get(sessionKey);
  session.phoneCredential = 'legacy-phone-credential';
  session.phoneId = 'legacy-phone-id';
  session.phoneLabel = 'Old phone';
  session.phoneDeviceType = 'iphone';
  await fixture.redis.set(sessionKey, session);
  await fixture.redis.set(`${sessionKey}:phone-lease`, 'legacy-connection', { ex: 20 });

  const added = await fixture.pairPhone(presenter);
  assert.equal(added.paired.label, 'Phone 2');
  await presenter.waitFor('phones', (message) => message.phones.length === 2);

  const resumed = await fixture.connect('phone');
  resumed.send({ type: 'resume', credential: 'legacy-phone-credential' });
  assert.deepEqual(await resumed.waitFor('resumed'), {
    type: 'resumed', phoneId: 'legacy-phone-id', label: 'Old phone', deviceType: 'iphone',
    state: { index: 0, total: 12, busy: false },
  });
  await presenter.waitFor('phones', (message) => message.phones.some((phone) =>
    phone.phoneId === 'legacy-phone-id' && phone.status === 'connected'));
});

test('hosted Redis relay preserves distinct phone pair rejection reasons', async (t) => {
  const scenarios = [
    {
      reason: 'session-missing',
      prepare: (fixture, sessionKey) => fixture.redis.del(sessionKey),
    },
    {
      reason: 'session-ended',
      prepare: async (fixture, sessionKey) => {
        const session = await fixture.redis.get(sessionKey);
        session.active = false;
        await fixture.redis.set(sessionKey, session);
      },
    },
    {
      reason: 'host-unavailable',
      prepare: (fixture) => fixture.redis.del(
        `gesturedeck:${fixture.pairing.sessionId}:presenter-lease`,
      ),
    },
    {
      reason: 'expired',
      prepare: async (fixture, sessionKey) => {
        const session = await fixture.redis.get(sessionKey);
        session.inviteExpiresAt = 0;
        await fixture.redis.set(sessionKey, session);
      },
    },
    {
      reason: 'invalid',
      prepare: (fixture) => {
        const evalRedis = fixture.redis.eval.bind(fixture.redis);
        fixture.redis.eval = async (script, keys, args) => (
          script.includes('-- REDIS_OP:PHONE_PAIR')
            ? 'unexpected-status'
            : evalRedis(script, keys, args)
        );
      },
    },
  ];

  for (const scenario of scenarios) {
    const fixture = await createFixture();
    t.after(() => fixture.close());
    await fixture.presenter();
    const sessionKey = `gesturedeck:${fixture.pairing.sessionId}`;
    await scenario.prepare(fixture, sessionKey);

    const phone = await fixture.connect('phone');
    phone.send({ type: 'pair', invite: fixture.pairing.fallbackUrl.split('#')[1], nickname: '', deviceType: 'phone' });
    assert.deepEqual(await phone.waitFor('pairRejected'), {
      type: 'pairRejected', reason: scenario.reason,
    });
  }
});

test('hosted Redis relay can renew the shared invite while phones remain paired', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const presenter = await fixture.presenter();
  const first = await fixture.pairPhone(presenter, { nickname: 'First phone' });
  const oldInvite = fixture.pairing.fallbackUrl.split('#')[1];

  const renewed = await postCloudRoute(fixture.server.address().port, 'renew-invite', {
    sessionId: fixture.pairing.sessionId,
    hostCredential: fixture.pairing.hostCredential,
  });
  assert.equal(renewed.status, 200);
  const renewedInvite = renewed.body.fallbackUrl.split('#')[1];
  assert.notEqual(renewedInvite, oldInvite);

  const staleLink = await fixture.connect('phone');
  staleLink.send({ type: 'pair', invite: oldInvite, nickname: '', deviceType: 'phone' });
  assert.deepEqual(await staleLink.waitFor('pairRejected'), {
    type: 'pairRejected', reason: 'invalid',
  });

  presenter.send({ type: 'state', index: 2, total: 12, busy: false });
  await first.peer.waitFor('state', (message) => message.index === 2);
  const second = await fixture.connect('phone');
  second.send({ type: 'pair', invite: renewedInvite, nickname: 'Second phone', deviceType: 'phone' });
  const paired = await second.waitFor('paired');
  const roster = await presenter.waitFor('phones', (message) => message.phones.length === 2);
  assert.equal(paired.label, 'Second phone');
  assert.deepEqual(
    roster.phones.map(({ phoneId }) => phoneId).sort(),
    [first.paired.phoneId, paired.phoneId].sort(),
  );
});

test('hosted Redis relay accepts eight phones on the same invite and rejects a ninth', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const presenter = await fixture.presenter();
  const phones = [];
  for (let index = 0; index < 8; index += 1) phones.push(await fixture.pairPhone(presenter));
  await presenter.waitFor('phones', (message) => message.phones.length === 8);

  const overflow = await fixture.connect('phone');
  overflow.send({ type: 'pair', invite: fixture.pairing.fallbackUrl.split('#')[1], nickname: '', deviceType: 'phone' });
  assert.deepEqual(await overflow.waitFor('pairRejected'), { type: 'pairRejected', reason: 'session-full' });
  assert.equal(phones.length, 8);
});
