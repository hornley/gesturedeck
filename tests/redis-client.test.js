import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedisClient } from '../src/redis-client.js';

test('Redis commands use the supplied per-request abort signal', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const redis = createRedisClient({
    UPSTASH_REDIS_REST_URL: 'https://redis.example.test',
    UPSTASH_REDIS_REST_TOKEN: 'test-token',
  }, { signal: () => AbortSignal.timeout(1), retry: false });
  const keepAlive = setTimeout(() => {}, 20);

  try {
    await assert.rejects(redis.set('analytics:login', '1'), { name: 'TimeoutError' });
  } finally {
    clearTimeout(keepAlive);
    globalThis.fetch = originalFetch;
  }
});
