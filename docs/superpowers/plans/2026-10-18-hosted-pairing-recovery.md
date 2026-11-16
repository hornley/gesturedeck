# Hosted Pairing Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Distinguish stale or invalid hosted pairing links from missing and ended sessions, explain the corresponding recovery action, and document when the Chrome extension version must change.

**Architecture:** Keep Redis session, invite, phone-record, and lease behavior unchanged. Translate the Redis phone-pair result into a specific WebSocket rejection reason, render specific copy in the existing phone client, and cover those contracts with the existing `node:test` suites. Add the extension release version rule to root `AGENTS.md`; do not bump the extension manifest for this hosted-relay-only change.

**Tech Stack:** Node.js 20, vanilla JavaScript modules, Upstash Redis Lua result strings, `node:test`.

---

### Task 1: Preserve hosted phone-pair rejection reasons

**Files:**
- Modify: `tests/cloud-remote-redis-server.test.js`
- Modify: `src/cloud-remote-redis-server.js`

- [ ] **Step 1: Add a hosted regression test for unavailable and expired sessions**

Insert this test before `hosted Redis relay can renew the shared invite while phones remain paired`:

```js
test('hosted Redis relay preserves distinct phone pair rejection reasons', async (t) => {
  const scenarios = [
    {
      reason: 'session-missing',
      prepare: (fixture, sessionKey) => fixture.redis.del(sessionKey),
    },
    {
      reason: 'session-ended',
      prepare: async (fixture, sessionKey) => {
        const session = await fixture.redis.get(sessionKey);
        session.active = false;
        await fixture.redis.set(sessionKey, session);
      },
    },
    {
      reason: 'expired',
      prepare: async (fixture, sessionKey) => {
        const session = await fixture.redis.get(sessionKey);
        session.inviteExpiresAt = 0;
        await fixture.redis.set(sessionKey, session);
      },
    },
  ];

  for (const scenario of scenarios) {
    const fixture = await createFixture();
    t.after(() => fixture.close());
    await fixture.presenter();
    const sessionKey = `gesturedeck:${fixture.pairing.sessionId}`;
    await scenario.prepare(fixture, sessionKey);

    const phone = await fixture.connect('phone');
    phone.send({
      type: 'pair',
      invite: fixture.pairing.fallbackUrl.split('#')[1],
      nickname: '',
      deviceType: 'phone',
    });
    assert.deepEqual(await phone.waitFor('pairRejected'), {
      type: 'pairRejected', reason: scenario.reason,
    });
  }
});
```

- [ ] **Step 2: Run the focused test and confirm missing/ended currently fail**

Run: `node --test --test-name-pattern="hosted Redis relay preserves distinct phone pair rejection reasons" tests/cloud-remote-redis-server.test.js`

Expected: FAIL because missing and ended Redis results currently become `reason: 'invalid'`; expired remains `reason: 'expired'`.

- [ ] **Step 3: Add a narrow Redis-result translator**

Add this helper immediately before `phoneIdentityFromScriptResult` in `src/cloud-remote-redis-server.js`:

```js
function phonePairRejectionReason(value) {
  if (value === 'missing') return 'session-missing';
  if (value === 'ended') return 'session-ended';
  return ['expired', 'invalid', 'session-full', 'host-unavailable'].includes(value)
    ? value
    : 'invalid';
}
```

Replace the inline mapping in the `PHONE_PAIR` handler with:

```js
const reason = phonePairRejectionReason(raw);
```

- [ ] **Step 4: Re-run the focused test**

Run: `node --test --test-name-pattern="hosted Redis relay preserves distinct phone pair rejection reasons" tests/cloud-remote-redis-server.test.js`

Expected: PASS for missing, ended, and expired sessions.

### Task 2: Show recovery copy for missing and ended sessions

**Files:**
- Modify: `tests/mobile-remote-phone.test.js`
- Modify: `src/mobile-remote-phone.js`

- [ ] **Step 1: Extend the reason-specific phone recovery test**

Add these cases to the table in `pair rejection renders reason-specific recovery for invalid, full, and unavailable hosts`:

```js
['session-missing', /session is no longer available/i],
['session-ended', /presenter ended this session/i],
```

- [ ] **Step 2: Run the focused test and confirm it fails for both new reasons**

Run: `node --test --test-name-pattern="pair rejection renders reason-specific recovery" tests/mobile-remote-phone.test.js`

Expected: FAIL because the new reasons currently fall back to generic pairing rejection copy.

- [ ] **Step 3: Add the two recovery messages**

Add these entries to `PAIR_ERRORS` in `src/mobile-remote-phone.js`:

```js
'session-missing': 'This presentation session is no longer available. Ask the presenter to start a new session and share its link.',
'session-ended': 'The presenter ended this session. Ask for a link from a new session.',
```

- [ ] **Step 4: Re-run the focused test**

Run: `node --test --test-name-pattern="pair rejection renders reason-specific recovery" tests/mobile-remote-phone.test.js`

Expected: PASS for invalid, expired, missing, ended, full, and unavailable results.

### Task 3: Lock down old-link behavior after invite renewal

**Files:**
- Modify: `tests/cloud-remote-redis-server.test.js`

- [ ] **Step 1: Assert the old invite is rejected while the renewed invite still pairs**

In `hosted Redis relay can renew the shared invite while phones remain paired`, insert this block after asserting `renewedInvite` differs from `oldInvite` and before pairing with `renewedInvite`:

```js
  const staleLink = await fixture.connect('phone');
  staleLink.send({ type: 'pair', invite: oldInvite, nickname: '', deviceType: 'phone' });
  assert.deepEqual(await staleLink.waitFor('pairRejected'), {
    type: 'pairRejected', reason: 'invalid',
  });
```

Keep the existing assertions that the renewed invite pairs and both phone records remain listed. This confirms the error distinction does not make an old invite valid or alter phone-record retention.

- [ ] **Step 2: Run the focused renewal test**

Run: `node --test --test-name-pattern="hosted Redis relay can renew the shared invite while phones remain paired" tests/cloud-remote-redis-server.test.js`

Expected: PASS; the stale invite is rejected as invalid, then the new invite pairs.

### Task 4: Document extension version bumps

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Add the release rule under `Changes and verification`**

Add this bullet after the JavaScript verification bullet:

```markdown
- Treat `extension/manifest.json`'s `version` as the extension release version. Bump its patch once per user-facing PR that changes extension code or packaged extension assets (for example, `0.1.0` to `0.1.1`); do not bump per commit or for application-only, test-only, or documentation-only changes. Keep it independent of `package.json` and `package-lock.json`.
```

Do not change `extension/manifest.json` for this task because no extension source or packaged extension asset changes.

### Task 5: Verify and commit the implementation

**Files:**
- Verify: `tests/cloud-remote-redis-server.test.js`
- Verify: `tests/mobile-remote-phone.test.js`
- Verify: `src/cloud-remote-redis-server.js`
- Verify: `src/mobile-remote-phone.js`
- Verify: `AGENTS.md`

- [ ] **Step 1: Run both focused test files**

Run: `node --test tests/cloud-remote-redis-server.test.js tests/mobile-remote-phone.test.js`

Expected: PASS.

- [ ] **Step 2: Run repository checks**

Run: `npm run check`

Expected: exit code 0.

Run: `npm run lint`

Expected: exit code 0.

Run: `npm test`

Expected: all tests pass. The test Redis model checks the local result mapping and does not execute production Lua or verify a deployed Vercel/Redis path.

- [ ] **Step 3: Review and commit the change**

Run:

```bash
git diff --check
git add AGENTS.md src/cloud-remote-redis-server.js src/mobile-remote-phone.js tests/cloud-remote-redis-server.test.js tests/mobile-remote-phone.test.js
git commit -m "fix: distinguish hosted phone pairing failures"
```

Expected: the implementation and guidance are committed on `codex/fix-hosted-pairing-link-recovery`. Open a new PR against `hornley/main` after the checks pass.
