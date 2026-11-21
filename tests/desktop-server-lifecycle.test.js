import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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
