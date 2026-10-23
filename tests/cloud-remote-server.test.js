import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { attachCloudRemote } from '../src/cloud-remote-server.js';

const ORIGIN = 'https://gesturedeck.test';
const HOST = 'gesturedeck.test';

class Peer {
  constructor(socket) {
    this.socket = socket;
    this.messages = [];
    this.waiters = [];
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.type === message.type);
      if (waiterIndex === -1) this.messages.push(message);
      else {
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    });
  }

  send(message) { this.socket.send(JSON.stringify(message)); }

  waitFor(type, timeoutMs = 1_000) {
    const messageIndex = this.messages.findIndex((message) => message.type === type);
    if (messageIndex !== -1) return Promise.resolve(this.messages.splice(messageIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {
        type,
        resolve,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          reject(new Error(`Timed out waiting for ${type}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = once(this.socket, 'close');
    this.socket.close();
    let timeout;
    try {
      await Promise.race([closed, new Promise((resolve) => { timeout = setTimeout(resolve, 500); })]);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function postStart(port) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1', port, path: '/api/cloud-remote/start', method: 'POST',
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
    request.end(JSON.stringify({ state: { index: 0, total: 12, busy: false } }));
  });
}

async function createFixture(t) {
  const server = createServer();
  const relay = attachCloudRemote(server, { createQr: () => 'data:image/png;base64,fixture' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const peers = new Set();
  t.after(async () => {
    await Promise.all([...peers].map((peer) => peer.close()));
    await relay.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const response = await postStart(server.address().port);
  assert.equal(response.status, 200);
  const pairing = response.body;
  async function connect(route) {
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.address().port}/ws/cloud-remote/${route}?session=${pairing.sessionId}`,
      { origin: ORIGIN, headers: { host: HOST } },
    );
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const peer = new Peer(socket);
    peers.add(peer);
    return peer;
  }

  async function presenter() {
    const peer = await connect('presenter');
    peer.send({ type: 'presenter', credential: pairing.hostCredential });
    await peer.waitFor('presenterReady');
    return peer;
  }

  return { pairing, connect, presenter };
}

test('in-memory cloud relay reports availability after phone pairing', async (t) => {
  const fixture = await createFixture(t);
  const presenter = await fixture.presenter();
  const phone = await fixture.connect('phone');
  phone.send({
    type: 'pair', invite: fixture.pairing.fallbackUrl.split('#')[1], nickname: '', deviceType: 'phone',
  });

  assert.equal((await phone.waitFor('paired')).type, 'paired');
  assert.deepEqual(await phone.waitFor('presenterStatus'), { type: 'presenterStatus', available: true });
  await presenter.close();
});

test('in-memory cloud relay reports availability after phone resume', async (t) => {
  const fixture = await createFixture(t);
  const presenter = await fixture.presenter();
  const phone = await fixture.connect('phone');
  phone.send({
    type: 'pair', invite: fixture.pairing.fallbackUrl.split('#')[1], nickname: '', deviceType: 'phone',
  });
  const paired = await phone.waitFor('paired');
  await phone.waitFor('presenterStatus');
  await phone.close();

  const resumed = await fixture.connect('phone');
  resumed.send({ type: 'resume', credential: paired.credential });
  assert.equal((await resumed.waitFor('resumed')).type, 'resumed');
  assert.deepEqual(await resumed.waitFor('presenterStatus'), { type: 'presenterStatus', available: true });

  resumed.send({ type: 'resume', credential: paired.credential });
  assert.equal((await resumed.waitFor('resumed')).type, 'resumed');
  assert.deepEqual(await resumed.waitFor('presenterStatus'), { type: 'presenterStatus', available: true });
  await presenter.close();
});
