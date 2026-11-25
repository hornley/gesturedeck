import { Redis } from '@upstash/redis';

export function createRedisClient(env = process.env, options = {}) {
  const url = env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ ...options, url, token });
}
