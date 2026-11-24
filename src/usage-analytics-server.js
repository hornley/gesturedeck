import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const PREFIX = 'gd:usage:v1:';
const SESSION_TTL_SECONDS = 24 * 60 * 60;
const DAILY_TTL_SECONDS = 90 * 24 * 60 * 60;
const EVENTS = new Set(['pdf_imported', 'phone_connected', 'phone_navigation', 'session_ended']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COUNTERS = [
  ['pdf_imports', 'pdfImports'],
  ['phone_connected_sessions', 'phoneConnectedSessions'],
  ['pdf_and_phone_sessions', 'pdfAndPhoneSessions'],
  ['phone_navigation_sessions', 'phoneNavigationSessions'],
  ['completed_presentations', 'completedPresentations'],
  ['presentation_seconds', 'presentationSeconds'],
];
const API_PATH = '/api/usage-analytics';
const TOKEN_COOKIE = 'gd_analytics';
const TOKEN_PREFIX = `${PREFIX}login:`;
const TOKEN_TTL_SECONDS = 12 * 60 * 60;
const MAX_API_BODY_BYTES = 1024;

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(body));
}

function sameOrigin(request) {
  if (typeof request.headers.host !== 'string' || typeof request.headers.origin !== 'string') return false;
  try {
    const origin = new URL(request.headers.origin);
    const forwardedProto = request.headers['x-forwarded-proto'];
    if (typeof forwardedProto === 'string' && (forwardedProto.includes(',') || !['http', 'https'].includes(forwardedProto.trim().toLowerCase()))) return false;
    const protocol = typeof forwardedProto === 'string'
      ? `${forwardedProto.trim().toLowerCase()}:` : request.socket?.encrypted ? 'https:' : 'http:';
    return ['http:', 'https:'].includes(protocol) && origin.protocol === protocol
      && origin.host.toLowerCase() === request.headers.host.toLowerCase()
      && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash;
  } catch { return false; }
}

function readApiJson(request) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) {
      request.resume(); reject(new Error('bad-request')); return;
    }
    const chunks = []; let size = 0; let oversized = false;
    request.on('data', (chunk) => { size += chunk.length; if (size > MAX_API_BODY_BYTES) oversized = true; else if (!oversized) chunks.push(chunk); });
    request.on('end', () => {
      if (oversized) { reject(new Error('bad-request')); return; }
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('bad-request');
        resolve(value);
      } catch { reject(new Error('bad-request')); }
    });
    request.on('error', () => reject(new Error('bad-request')));
  });
}

function cookieToken(request) {
  const match = (request.headers.cookie ?? '').match(/(?:^|;\s*)gd_analytics=([A-Za-z0-9_-]{40,})/);
  return match?.[1] ?? null;
}

function hashedToken(token) { return createHash('sha256').update(token).digest('hex'); }
function isValidTokenMarker(value) { return value === 1 || value === '1'; }

export function attachUsageAnalytics(server, { redis, env = process.env, now = Date.now } = {}) {
  let client = redis;
  const getRedis = async () => {
    if (client !== undefined) return client;
    try { const { createRedisClient } = await import('./redis-client.js'); client = createRedisClient(env); } catch { client = null; }
    return client;
  };
  server.on('request', async (request, response) => {
    let parsed;
    try { parsed = new URL(request.url, 'http://gesturedeck.invalid'); } catch { sendJson(response, 400, { error: 'bad_request' }); return; }
    if (parsed.pathname !== API_PATH) return;
    const routes = parsed.searchParams.getAll('__gd_route');
    const route = routes.length === 1 ? routes[0] : null;
    if (!['event', 'login', 'logout', 'summary'].includes(route)) { sendJson(response, 404, { error: 'not_found' }); return; }
    const store = await getRedis();
    if (route === 'summary' && request.method === 'GET') {
      if (parsed.searchParams.getAll('days').length !== 1 || [...parsed.searchParams.keys()].some((key) => !['__gd_route', 'days'].includes(key))) { sendJson(response, 400, { error: 'bad_request' }); return; }
      const days = Number(parsed.searchParams.get('days'));
      if (![7, 30, 90].includes(days)) { sendJson(response, 400, { error: 'bad_request' }); return; }
      if (typeof env.ANALYTICS_PASSWORD !== 'string' || !env.ANALYTICS_PASSWORD || !store?.get || !store?.hgetall) { sendJson(response, 503, { error: 'unavailable' }); return; }
      const token = cookieToken(request);
      if (!token) { sendJson(response, 401, { error: 'unauthorized' }); return; }
      try {
        if (!isValidTokenMarker(await store.get(`${TOKEN_PREFIX}${hashedToken(token)}`))) { sendJson(response, 401, { error: 'unauthorized' }); return; }
        sendJson(response, 200, await readUsageSummary(store, { days, now: now() }));
      } catch { sendJson(response, 503, { error: 'unavailable' }); }
      return;
    }
    if (request.method !== 'POST') { sendJson(response, 405, { error: 'bad_request' }); return; }
    if (!sameOrigin(request)) { sendJson(response, 403, { error: 'forbidden' }); return; }
    let body;
    try { body = await readApiJson(request); } catch { sendJson(response, 400, { error: 'bad_request' }); return; }
    if (parsed.searchParams.getAll('__gd_route').length !== 1 || [...parsed.searchParams.keys()].some((key) => key !== '__gd_route')) { sendJson(response, 400, { error: 'bad_request' }); return; }
    if (route === 'event') {
      if (!['event', 'sessionId'].every((key) => Object.hasOwn(body, key)) || Object.keys(body).some((key) => !['event', 'sessionId'].includes(key))) { sendJson(response, 400, { error: 'bad_request' }); return; }
      if (!EVENTS.has(body.event) || typeof body.sessionId !== 'string' || !UUID_PATTERN.test(body.sessionId)) { sendJson(response, 400, { error: 'bad_request' }); return; }
      if (env.VERCEL_ENV !== 'production') { sendJson(response, 200, { ok: true }); return; }
      if (!store || typeof store.eval !== 'function') { sendJson(response, 503, { error: 'unavailable' }); return; }
      try { await trackUsageEvent(store, body); sendJson(response, 200, { ok: true }); } catch (error) {
        sendJson(response, 503, { error: 'unavailable' });
      }
      return;
    }
    if (route === 'login') {
      if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'password')) { sendJson(response, 400, { error: 'bad_request' }); return; }
      const configured = env.ANALYTICS_PASSWORD;
      if (typeof configured !== 'string' || !configured || !store?.set) { sendJson(response, 503, { error: 'unavailable' }); return; }
      const supplied = typeof body.password === 'string' ? Buffer.from(body.password) : Buffer.alloc(0);
      const expected = Buffer.from(configured);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied.length === expected.length ? supplied : Buffer.alloc(expected.length), expected)) { sendJson(response, 401, { error: 'unauthorized' }); return; }
      const token = randomBytes(32).toString('base64url');
      try {
        await store.set(`${TOKEN_PREFIX}${hashedToken(token)}`, '1', { ex: TOKEN_TTL_SECONDS });
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
          'set-cookie': `${TOKEN_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=${API_PATH}; Max-Age=${TOKEN_TTL_SECONDS}` });
        response.end(JSON.stringify({ ok: true }));
      } catch { sendJson(response, 503, { error: 'unavailable' }); }
      return;
    }
    if (route === 'logout') {
      if (Object.keys(body).length !== 0) { sendJson(response, 400, { error: 'bad_request' }); return; }
      const token = cookieToken(request);
      if (!token || !store?.get || !store?.del) { sendJson(response, 401, { error: 'unauthorized' }); return; }
      try {
        const key = `${TOKEN_PREFIX}${hashedToken(token)}`;
        if (!isValidTokenMarker(await store.get(key))) { sendJson(response, 401, { error: 'unauthorized' }); return; }
        await store.del(key);
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
          'set-cookie': `${TOKEN_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=${API_PATH}; Max-Age=0` });
        response.end(JSON.stringify({ ok: true }));
      } catch { sendJson(response, 503, { error: 'unavailable' }); }
      return;
    }
    sendJson(response, 404, { error: 'not_found' });
  });
}

export const USAGE_EVENT_SCRIPT = `
local sessionKey, dailyKey = KEYS[1], KEYS[2]
local event, now = ARGV[1], tonumber(ARGV[2])
local newSession = redis.call('EXISTS', sessionKey) == 0
local function flag(name) return redis.call('HGET', sessionKey, name) == '1' end
local function increment(field, amount)
  redis.call('HINCRBY', dailyKey, field, amount)
end
if event == 'pdf_imported' and not flag('pdf') then
  redis.call('HSET', sessionKey, 'pdf', '1'); increment('pdf_imports', 1)
end
if event == 'phone_connected' and not flag('phone') then
  redis.call('HSET', sessionKey, 'phone', '1', 'first_phone_at', now)
  increment('phone_connected_sessions', 1)
end
if event == 'phone_navigation' and not flag('navigation') then
  redis.call('HSET', sessionKey, 'navigation', '1'); increment('phone_navigation_sessions', 1)
end
if flag('pdf') and flag('phone') and not flag('combined') then
  redis.call('HSET', sessionKey, 'combined', '1'); increment('pdf_and_phone_sessions', 1)
end
if event == 'session_ended' and flag('phone') and not flag('ended') then
  local firstPhoneAt = tonumber(redis.call('HGET', sessionKey, 'first_phone_at')) or now
  local seconds = math.min(14400, math.max(0, math.floor((now - firstPhoneAt) / 1000)))
  redis.call('HSET', sessionKey, 'ended', '1')
  increment('completed_presentations', 1); increment('presentation_seconds', seconds)
end
redis.call('EXPIRE', dailyKey, ARGV[4])
if newSession then redis.call('EXPIRE', sessionKey, ARGV[3]) end
return 1
`;

function validateNow(now) {
  const value = now === undefined ? Date.now() : now;
  if (!Number.isFinite(value)) throw new TypeError('Invalid timestamp');
  return value;
}

function utcDate(timestamp) { return new Date(timestamp).toISOString().slice(0, 10); }

export async function trackUsageEvent(redis, { event, sessionId, now } = {}) {
  if (!redis || typeof redis.eval !== 'function') throw new TypeError('Redis is required');
  if (arguments.length < 2) throw new TypeError('Event payload is required');
  if (!['event', 'sessionId'].every((key) => key in arguments[1]) || Object.keys(arguments[1]).some((key) => !['event', 'sessionId', 'now'].includes(key))) {
    throw new TypeError('Invalid event fields');
  }
  if (!EVENTS.has(event)) throw new TypeError('Invalid event');
  if (typeof sessionId !== 'string' || !UUID_PATTERN.test(sessionId)) throw new TypeError('Invalid session ID');
  const timestamp = validateNow(now);
  const day = utcDate(timestamp);
  await redis.eval(USAGE_EVENT_SCRIPT,
    [`${PREFIX}session:${sessionId}`, `${PREFIX}day:${day}`],
    [event, String(timestamp), String(SESSION_TTL_SECONDS), String(DAILY_TTL_SECONDS)]);
}

function emptyRow(date) {
  return Object.fromEntries([['date', date], ...COUNTERS.map(([field]) => [field, 0])]);
}

export async function readUsageSummary(redis, { days, now } = {}) {
  if (!redis || typeof redis.hgetall !== 'function') throw new TypeError('Redis is required');
  if (![7, 30, 90].includes(days)) throw new TypeError('Invalid day range');
  const timestamp = validateNow(now);
  const today = new Date(timestamp);
  const dates = Array.from({ length: days }, (_, index) => {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - days + index + 1));
    return date.toISOString().slice(0, 10);
  });
  const daily = await Promise.all(dates.map(async (date) => {
    const data = await redis.hgetall(`${PREFIX}day:${date}`) ?? {};
    const row = emptyRow(date);
    for (const [field] of COUNTERS) row[field] = Number(data[field] ?? 0);
    return row;
  }));
  const totals = Object.fromEntries(COUNTERS.map(([field, camel]) => [camel, daily.reduce((sum, row) => sum + row[field], 0)]));
  totals.averagePresentationSeconds = totals.completedPresentations
    ? totals.presentationSeconds / totals.completedPresentations : 0;
  return { days, totals, daily };
}
