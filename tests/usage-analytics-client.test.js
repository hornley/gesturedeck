import test from 'node:test';
import assert from 'node:assert/strict';
import { getUsageSessionId, trackUsageEvent } from '../src/usage-analytics-client.js';

function storage() {
  const values = new Map();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test('usage session id is stored per tab and rotates after 24 hours', () => {
  const store = storage();
  const crypto = { randomUUID: () => 'random-session' };
  const first = getUsageSessionId(store, crypto, 1000);
  assert.equal(getUsageSessionId(store, crypto, 1001), first);
  assert.equal(getUsageSessionId(store, crypto, 1000 + 24 * 60 * 60 * 1000), 'random-session');
  assert.deepEqual([...store.values.keys()], ['usageSession']);
});

test('usage event sends only the approved event and session id', async () => {
  const calls = [];
  await trackUsageEvent('pdf_imported', { storage: storage(), crypto: { randomUUID: () => 'id' }, fetch: async (...args) => calls.push(args) });
  assert.equal(calls[0][0], '/api/usage-analytics/event');
  assert.deepEqual(JSON.parse(calls[0][1].body), { event: 'pdf_imported', sessionId: 'id' });
});

test('unknown events and transport failures are ignored', async () => {
  let calls = 0;
  const options = { storage: storage(), crypto: { randomUUID: () => 'id' }, fetch: async () => { calls += 1; throw new Error('offline'); } };
  await assert.doesNotReject(trackUsageEvent('phone_label', options));
  await assert.doesNotReject(trackUsageEvent('phone_connected', options));
  assert.equal(calls, 1);
});

test('session end prefers beacon and falls back to keepalive fetch', async () => {
  const sent = [];
  const options = { storage: storage(), crypto: { randomUUID: () => 'id' }, sendBeacon: (_url, body) => { sent.push(JSON.parse(body)); return true; } };
  await trackUsageEvent('session_ended', { ...options, keepalive: true });
  assert.deepEqual(sent, [{ event: 'session_ended', sessionId: 'id' }]);
});
