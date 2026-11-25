import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { trackUsageEvent, readUsageSummary, attachUsageAnalytics } from '../src/usage-analytics-server.js';
import vercel from '../vercel.json' with { type: 'json' };

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';
const FIELDS = ['pdf_imports', 'phone_connected_sessions', 'pdf_and_phone_sessions',
  'phone_navigation_sessions', 'completed_presentations', 'presentation_seconds'];

async function withApi(options, run) {
  const server = createServer();
  attachUsageAnalytics(server, options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('Vercel exposes the four public usage analytics routes', () => {
  for (const route of ['event', 'login', 'logout', 'summary']) {
    assert.ok(vercel.rewrites.some(({ source, destination }) => source === `/api/usage-analytics/${route}`
      && destination === `/api/usage-analytics?__gd_route=${route}`));
  }
});

test('analytics API validates event input and reports unavailable Redis', async () => {
  const redis = new ApiRedis();
  await withApi({ redis, env: { VERCEL_ENV: 'production', ANALYTICS_PASSWORD: 'secret' } }, async (base) => {
    const request = (body, { origin = base, contentType = 'application/json' } = {}) => fetch(`${base}/api/usage-analytics?__gd_route=event`, {
      method: 'POST', headers: { origin, 'content-type': contentType }, body,
    });
    for (const event of ['pdf_imported', 'phone_connected', 'phone_navigation', 'session_ended']) {
      assert.equal((await request(JSON.stringify({ event, sessionId: SESSION_ID }))).status, 200);
    }
    assert.equal(redis.eventCalls, 4);
    assert.equal((await request(JSON.stringify({ event: 'pdf_imported', sessionId: SESSION_ID, extra: 1 }))).status, 400);
    assert.equal((await request('{')).status, 400);
    assert.equal((await request('{"event":"pdf_imported","sessionId":"550e8400-e29b-41d4-a716-446655440000"', { contentType: 'text/plain' })).status, 400);
    assert.equal((await request(JSON.stringify({ event: 'pdf_imported', sessionId: SESSION_ID }), { origin: 'https://elsewhere.test' })).status, 403);
    assert.equal((await request(JSON.stringify({ event: 'pdf_imported', sessionId: SESSION_ID }), { origin: base.replace('http:', 'https:') })).status, 403);
    assert.equal((await request(' '.repeat(1025))).status, 400);
  });
  await withApi({ env: { VERCEL_ENV: 'production' } }, async (base) => {
    const response = await fetch(`${base}/api/usage-analytics?__gd_route=event`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ event: 'pdf_imported', sessionId: SESSION_ID }) });
    assert.equal(response.status, 503);
  });
});

test('preview drops valid events but still rejects malformed events', async () => {
  const redis = new ApiRedis();
  await withApi({ redis, env: { VERCEL_ENV: 'preview' } }, async (base) => {
    const send = (payload) => fetch(`${base}/api/usage-analytics?__gd_route=event`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal((await send({ event: 'pdf_imported', sessionId: SESSION_ID })).status, 200);
    assert.equal((await send({ event: 'not-real', sessionId: SESSION_ID })).status, 400);
    assert.equal(redis.eventCalls, 0);
  });
});

test('missing analytics configuration never returns a summary', async () => {
  await withApi({ redis: new ApiRedis(), env: {} }, async (base) => {
    const login = await fetch(`${base}/api/usage-analytics?__gd_route=login`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'guess' }) });
    assert.equal(login.status, 503);
    const summary = await fetch(`${base}/api/usage-analytics?__gd_route=summary&days=7`, { headers: { cookie: 'gd_analytics=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });
    assert.equal(summary.status, 503);
  });
  await withApi({ env: { ANALYTICS_PASSWORD: 'secret' } }, async (base) => {
    const login = await fetch(`${base}/api/usage-analytics?__gd_route=login`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'secret' }) });
    assert.equal(login.status, 503);
    const summary = await fetch(`${base}/api/usage-analytics?__gd_route=summary&days=7`);
    assert.equal(summary.status, 401);
  });
});

test('analytics login gates summary and logout revokes its Redis token', async () => {
  const redis = new ApiRedis();
  const env = { VERCEL_ENV: 'production', ANALYTICS_PASSWORD: 'secret' };
  await withApi({ redis, env, now: () => 0 }, async (base) => {
    const post = (route, body = {}, cookie = '') => fetch(`${base}/api/usage-analytics?__gd_route=${route}`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body), redirect: 'manual' });
    const summary = () => fetch(`${base}/api/usage-analytics?__gd_route=summary&days=7`);
    assert.equal((await summary()).status, 401);
    assert.equal((await post('login', { password: 'wrong' })).status, 401);
    const login = await post('login', { password: 'secret' });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\/api\/usage-analytics/); assert.match(cookie, /Max-Age=43200/);
    const token = decodeURIComponent(cookie.match(/gd_analytics=([^;,]+)/)[1]);
    const key = redis.values.keys().next().value;
    assert.ok(key); assert.ok(!key.includes(token)); assert.equal(redis.lastSetArgs.at(-1).ex, 43200);
    assert.equal(await redis.get(key), 1);
    assert.equal((await fetch(`${base}/api/usage-analytics?__gd_route=summary&days=7`, { headers: { cookie: `gd_analytics=${token}` } })).status, 200);
    assert.equal((await fetch(`${base}/api/usage-analytics?__gd_route=summary&days=8`, { headers: { cookie: `gd_analytics=${token}` } })).status, 400);
    const logout = await post('logout', {}, `gd_analytics=${token}`);
    assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await fetch(`${base}/api/usage-analytics?__gd_route=summary&days=7`, { headers: { cookie: `gd_analytics=${token}` } })).status, 401);
  });
});

test('analytics routes return unavailable when Redis operations never settle', async () => {
  const never = () => new Promise(() => {});
  const env = { VERCEL_ENV: 'production', ANALYTICS_PASSWORD: 'secret' };
  await withApi({ redis: { set: never }, env, redisRequestTimeoutMs: 10 }, async (base) => {
    const response = await fetch(`${base}/api/usage-analytics?__gd_route=login`, {
      method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'secret' }),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'unavailable' });
  });
  await withApi({ redis: { get: async () => 1, hgetall: never }, env, redisRequestTimeoutMs: 10 }, async (base) => {
    const response = await fetch(`${base}/api/usage-analytics?__gd_route=summary&days=7`, {
      headers: { cookie: `gd_analytics=${'a'.repeat(43)}` },
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'unavailable' });
  });
});

test('analytics timeout aborts the pending Upstash request', async () => {
  const originalFetch = globalThis.fetch;
  let requestSignal;
  globalThis.fetch = (url, options = {}) => {
    if (!String(url).startsWith('https://redis.example.test/')) return originalFetch(url, options);
    requestSignal = options.signal;
    return new Promise((_, reject) => requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true }));
  };
  try {
    await withApi({
      env: {
        VERCEL_ENV: 'production', ANALYTICS_PASSWORD: 'secret',
        UPSTASH_REDIS_REST_URL: 'https://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'test-token',
      },
      redisRequestTimeoutMs: 10,
    }, async (base) => {
      const response = await fetch(`${base}/api/usage-analytics?__gd_route=login`, {
        method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'secret' }),
      });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'unavailable' });
      assert.equal(requestSignal.aborted, true);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// This fake implements the script's state transition atomically; it does not run Redis Lua.
class FakeRedis {
  sessions = new Map();
  days = new Map();
  sessionExpiresAt = new Map();
  dayExpiresAt = new Map();
  now = 0;

  setNow(now) { this.now = now; }
  expireMap(values, expirations, now) {
    for (const [key, expiresAt] of expirations) {
      if (expiresAt <= now) { values.delete(key); expirations.delete(key); }
    }
  }

  async eval(_script, keys, args) {
    const [sessionKey, dayKey] = keys;
    const [event, rawNow, sessionTtl, dailyTtl] = args;
    const now = Number(rawNow);
    this.now = now;
    this.expireMap(this.sessions, this.sessionExpiresAt, now);
    this.expireMap(this.days, this.dayExpiresAt, now);
    const isNewSession = !this.sessions.has(sessionKey);
    const state = this.sessions.get(sessionKey) ?? { pdf: false, phone: false, combined: false, navigation: false, ended: false, firstPhoneAt: null };
    const counts = this.days.get(dayKey) ?? Object.fromEntries(FIELDS.map((field) => [field, 0]));
    if (event === 'pdf_imported' && !state.pdf) { state.pdf = true; counts.pdf_imports++; }
    if (event === 'phone_connected' && !state.phone) { state.phone = true; state.firstPhoneAt = Number(now); counts.phone_connected_sessions++; }
    if (event === 'phone_navigation' && !state.navigation) { state.navigation = true; counts.phone_navigation_sessions++; }
    if (state.pdf && state.phone && !state.combined) { state.combined = true; counts.pdf_and_phone_sessions++; }
    if (event === 'session_ended' && state.phone && !state.ended) {
      state.ended = true;
      counts.completed_presentations++;
      counts.presentation_seconds += Math.min(14_400, Math.max(0, Math.floor((Number(now) - state.firstPhoneAt) / 1000)));
    }
    this.sessions.set(sessionKey, state);
    if (isNewSession) this.sessionExpiresAt.set(sessionKey, now + Number(sessionTtl) * 1000);
    this.days.set(dayKey, counts);
    this.dayExpiresAt.set(dayKey, now + Number(dailyTtl) * 1000);
    return 1;
  }
  async hgetall(key) {
    this.expireMap(this.sessions, this.sessionExpiresAt, this.now);
    this.expireMap(this.days, this.dayExpiresAt, this.now);
    return this.days.get(key) ?? {};
  }
}

class ApiRedis extends FakeRedis {
  values = new Map();
  eventCalls = 0;
  async eval(...args) { this.eventCalls++; return super.eval(...args); }
  async set(key, value, ...args) { this.values.set(key, value); this.lastSetArgs = args; return 'OK'; }
  async get(key) {
    const value = this.values.get(key);
    // Upstash parses numeric JSON values on GET, so the stored marker reads back as a number.
    return value === undefined ? null : typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
  }
  async del(key) { this.values.delete(key); }
}

test('tracks deduplicated events and computes daily and total summary', async () => {
  const redis = new FakeRedis();
  let now = Date.UTC(2026, 10, 25);
  let connectedAt = now;
  for (const event of ['pdf_imported', 'pdf_imported', 'phone_connected', 'phone_navigation', 'session_ended', 'session_ended']) {
    if (event === 'phone_connected') connectedAt = now;
    if (event === 'session_ended') now = connectedAt + 120_000;
    await trackUsageEvent(redis, { event, sessionId: SESSION_ID, now });
  }
  const summary = await readUsageSummary(redis, { days: 7, now });
  assert.deepEqual(summary.totals, {
    pdfImports: 1, phoneConnectedSessions: 1, pdfAndPhoneSessions: 1,
    phoneNavigationSessions: 1, completedPresentations: 1, presentationSeconds: 120,
    averagePresentationSeconds: 120,
  });
  assert.equal(summary.daily.length, 7);
});

test('rejects invalid event payloads', async () => {
  const redis = new FakeRedis();
  for (const input of [
    { event: 'pdf_imported', sessionId: SESSION_ID, extra: true },
    { event: 'unknown', sessionId: SESSION_ID },
    { event: 'pdf_imported', sessionId: 'bad' },
    { event: 'session_ended', sessionId: SESSION_ID, duration: 12 },
  ]) await assert.rejects(trackUsageEvent(redis, { ...input, now: 0 }));
});

test('defaults an omitted timestamp to the current clock', async () => {
  const redis = new FakeRedis();
  const originalNow = Date.now;
  const expectedNow = Date.UTC(2026, 10, 25, 12);
  Date.now = () => expectedNow;
  try {
    await trackUsageEvent(redis, { event: 'pdf_imported', sessionId: SESSION_ID });
  } finally {
    Date.now = originalNow;
  }
  assert.equal(redis.now, expectedNow);
  assert.equal((await redis.hgetall('gd:usage:v1:day:2026-11-25')).pdf_imports, 1);
});

test('caps duration at four hours and clamps negative elapsed time to zero', async () => {
  const capped = new FakeRedis();
  await trackUsageEvent(capped, { event: 'phone_connected', sessionId: SESSION_ID, now: 0 });
  await trackUsageEvent(capped, { event: 'session_ended', sessionId: SESSION_ID, now: 20_000_000 });
  assert.equal((await readUsageSummary(capped, { days: 7, now: 20_000_000 })).totals.presentationSeconds, 14_400);
  const negative = new FakeRedis();
  await trackUsageEvent(negative, { event: 'phone_connected', sessionId: SESSION_ID, now: 10_000 });
  await trackUsageEvent(negative, { event: 'session_ended', sessionId: SESSION_ID, now: 0 });
  assert.equal((await readUsageSummary(negative, { days: 7, now: 10_000 })).totals.presentationSeconds, 0);
});

test('session TTL starts at the first event and daily aggregates expire after 90 days', async () => {
  const redis = new FakeRedis();
  const firstAt = Date.UTC(2026, 10, 25);
  const sessionKey = `gd:usage:v1:session:${SESSION_ID}`;
  const dayKey = 'gd:usage:v1:day:2026-11-25';
  await trackUsageEvent(redis, { event: 'pdf_imported', sessionId: SESSION_ID, now: firstAt });
  await trackUsageEvent(redis, { event: 'phone_connected', sessionId: SESSION_ID, now: firstAt + 23 * 60 * 60 * 1000 });
  assert.equal(redis.sessionExpiresAt.get(sessionKey), firstAt + 24 * 60 * 60 * 1000);
  assert.equal((await redis.hgetall(dayKey)).pdf_imports, 1);

  redis.setNow(firstAt + 24 * 60 * 60 * 1000);
  await redis.hgetall(dayKey);
  assert.equal(redis.sessions.has(sessionKey), false);
  redis.setNow(firstAt + 23 * 60 * 60 * 1000 + 90 * 24 * 60 * 60 * 1000);
  assert.deepEqual(await redis.hgetall(dayKey), {});
});
