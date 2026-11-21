import { createAppServer } from '../server.mjs';

function closeHttpServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function closeRemotes(server) {
  const results = await Promise.allSettled([
    server.cloudRemote?.close(),
    server.mobileRemote?.close(),
  ]);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
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
    await closeRemotes(server).catch(() => {});
    throw error;
  }

  let stopped;
  return {
    server,
    port: server.address().port,
    stop() {
      stopped ??= (async () => {
        await closeRemotes(server);
        await closeHttpServer(server);
      })();
      return stopped;
    },
  };
}
