import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { startDesktopServer } from '../desktop/server-lifecycle.mjs';

test('desktop server resolves after serving the real workspace and stops cleanly', async () => {
  const lifecycle = await startDesktopServer({ host: '127.0.0.1', port: 0 });
  try {
    assert.equal(lifecycle.server.listening, true);
    const response = await fetch(`http://127.0.0.1:${lifecycle.port}/workspace.html`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /GestureDeck/);
  } finally {
    await lifecycle.stop();
  }
  assert.equal(lifecycle.server.listening, false);
});

test('desktop server closes attached remotes when its port is occupied', async () => {
  const occupied = http.createServer();
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  let cloudClosed = false;
  let mobileClosed = false;
  try {
    await assert.rejects(startDesktopServer({
      host: '127.0.0.1',
      port: occupied.address().port,
      createServer() {
        const server = http.createServer();
        server.cloudRemote = { close: async () => { cloudClosed = true; } };
        server.mobileRemote = { close: async () => { mobileClosed = true; } };
        return server;
      },
    }), /port|listen|address/i);
    assert.equal(cloudClosed, true);
    assert.equal(mobileClosed, true);
  } finally {
    await new Promise((resolve) => occupied.close(resolve));
  }
});

test('desktop server awaits both remotes before stopping HTTP and shares concurrent stops', async () => {
  const order = [];
  const lifecycle = await startDesktopServer({
    host: '127.0.0.1',
    port: 0,
    createServer() {
      const server = http.createServer();
      server.cloudRemote = { close: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); order.push('cloud'); } };
      server.mobileRemote = { close: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); order.push('mobile'); } };
      const close = server.close.bind(server);
      server.close = (...args) => {
        order.push('http');
        return close(...args);
      };
      return server;
    },
  });

  const first = lifecycle.stop();
  assert.equal(lifecycle.stop(), first);
  await first;
  assert.deepEqual(order.slice().sort(), ['cloud', 'http', 'mobile'].sort());
  assert.equal(order.at(-1), 'http');
});

test('desktop server force-closes an incomplete HTTP request after the grace period', { timeout: 2_000 }, async (t) => {
  const lifecycle = await startDesktopServer({ host: '127.0.0.1', port: 0 });
  const socket = net.connect(lifecycle.port, '127.0.0.1');
  t.after(() => {
    socket.destroy();
    lifecycle.server.closeAllConnections();
  });
  await once(socket, 'connect');
  socket.write('GET /workspace.html HTTP/1.1\r\nHost: 127.0.0.1\r\n');
  const closed = once(socket, 'close');
  await lifecycle.stop();
  await closed;
  assert.equal(lifecycle.server.listening, false);
});

test('desktop server stops HTTP even when a remote close rejects', async () => {
  const lifecycle = await startDesktopServer({
    host: '127.0.0.1',
    port: 0,
    createServer() {
      const server = http.createServer();
      server.cloudRemote = { close: async () => { throw new Error('remote close failed'); } };
      server.mobileRemote = { close: async () => {} };
      return server;
    },
  });

  await assert.rejects(lifecycle.stop(), /shutdown failed/);
  assert.equal(lifecycle.server.listening, false);
});
