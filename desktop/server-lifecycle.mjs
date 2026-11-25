import { createAppServer } from '../server.mjs';

function closeHttpServer(server, graceMs = 250) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer;
    server.close((error) => {
      clearTimeout(timer);
      error ? reject(error) : resolve();
    });
    timer = setTimeout(() => server.closeAllConnections(), graceMs);
  });
}

async function stopServer(server) {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => server.cloudRemote?.close()),
    Promise.resolve().then(() => server.mobileRemote?.close()),
  ]);
  const httpResult = await Promise.allSettled([closeHttpServer(server)]);
  const failures = [...results, ...httpResult]
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, 'GestureDeck shutdown failed');
}

export async function startDesktopServer({ host = '0.0.0.0', port = 5173, createServer = createAppServer } = {}) {
  const server = createServer({ host });
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  } catch (error) {
    await Promise.allSettled([
      Promise.resolve().then(() => server.cloudRemote?.close()),
      Promise.resolve().then(() => server.mobileRemote?.close()),
    ]);
    throw error;
  }

  let stopped;
  return {
    server,
    port: server.address().port,
    stop() {
      stopped ??= (async () => {
        await stopServer(server);
      })();
      return stopped;
    },
  };
}
