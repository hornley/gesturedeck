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
