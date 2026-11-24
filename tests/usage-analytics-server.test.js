import test from 'node:test';
import assert from 'node:assert/strict';
import { trackUsageEvent, readUsageSummary } from '../src/usage-analytics-server.js';

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';
const FIELDS = ['pdf_imports', 'phone_connected_sessions', 'pdf_and_phone_sessions',
  'phone_navigation_sessions', 'completed_presentations', 'presentation_seconds'];

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
