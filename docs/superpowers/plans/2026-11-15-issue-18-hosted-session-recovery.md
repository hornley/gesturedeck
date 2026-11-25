# Hosted Session Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover a hosted phone session after a transient presenter WebSocket close without forcing phones to pair again, while keeping explicit Stop terminal.

**Architecture:** Redis remains the source of truth for the hosted session. A transient socket close releases only its connection lease; the hosted presenter reconnects with the same in-memory credentials, and phone commands are rejected while no presenter lease exists. Replayed command IDs must not trigger non-idempotent slide navigation twice. Local presenter behavior remains unchanged.

**Tech Stack:** Node.js 20, vanilla JavaScript ES modules, `ws`, Upstash Redis Lua scripts, and Node's built-in test runner.

---

## Files and responsibilities

- `src/cloud-remote-redis-server.js`: hosted session lease lifecycle, phone command admission, explicit stop route, and presenter event retention/polling.
- `src/mobile-remote-client.js`: opt-in presenter reconnect, state republishing, stale-socket fencing, and command-result deduplication.
- `app.js`: enable retries for cloud sessions only, preserve pairing UI while reconnecting, and cancel retries on explicit stop/page hide.
- `tests/cloud-remote-redis-server.test.js`: fake Redis model and hosted relay lifecycle/command tests.
- `tests/mobile-remote-client.test.js`: retry timing, terminal rejection, duplicate command, state, and stale-socket tests.
- `tests/app.test.js`: cloud reconnect UI, explicit stop, page-hide cleanup, and local behavior regression tests.
- `api/cloud-remote.js` and `api/cloud-remote-ws.js`: no changes expected; both use the shared Redis relay module.
- `src/mobile-remote-phone.js` and `tests/mobile-remote-phone.test.js`: existing phone retry/resume behavior; verify it remains nonterminal during a temporary presenter outage.

## Task 1: Specify relay disconnect and command behavior in tests

**Files:** `tests/cloud-remote-redis-server.test.js`

- [ ] **Step 1: Add a presenter-close regression test.** Use the existing `createFixture`, `presenter`, `pairPhone`, and `Peer.close` helpers.

```js
test('hosted Redis relay keeps the session and phone identity after presenter disconnect', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const presenter = await fixture.presenter();
  const phone = await fixture.pairPhone(presenter);
  const sessionKey = `gesturedeck:${fixture.pairing.sessionId}`;

  await presenter.close();

  const session = await fixture.redis.get(sessionKey);
  assert.equal(session.active, true);
  assert.equal(session.phones[phone.paired.phoneId].credential, phone.paired.credential);
  assert.equal(phone.peer.messages.some((message) => message.type === 'sessionEnded'), false);
});
```

- [ ] **Step 2: Add a no-presenter command test.** Close the presenter, send one `next` command from the still-paired phone, and assert the phone receives `{ type: 'commandAck', id: 'offline-next', accepted: false }`. Also assert that no `command` with ID `${phone.paired.phoneId}.offline-next` was added to `gesturedeck:${sessionId}:to-presenter`.
- [ ] **Step 3: Add a stale-close lease test.** After authenticating a presenter, replace `gesturedeck:${sessionId}:presenter-lease` in the fake Redis values with a new connection ID, close the old peer, and assert the new lease remains and the session stays active.
- [ ] **Step 4: Add an explicit-stop regression.** Call the existing `postCloudRoute` helper with route `stop` and `{ sessionId, hostCredential }`. Assert HTTP 200, `session.active === false`, a phone `sessionEnded` event, and that its old credential cannot resume.
- [ ] **Step 5: Run the relay tests to see the expected failures.**

Run: `node --test tests/cloud-remote-redis-server.test.js`

Expected: the new disconnect test fails because the current close handler deactivates the session and sends `sessionEnded`; the no-presenter test fails because a command can enter the stream without a presenter lease.

## Task 2: Separate connection release from session end

**Files:** `src/cloud-remote-redis-server.js`, `tests/cloud-remote-redis-server.test.js`

- [ ] **Step 1: Change the release script to delete only the matching live lease.** Keep the Redis operation atomic and do not rewrite the session or extend its TTL.

```js
const RELEASE_PRESENTER_SCRIPT = `
-- REDIS_OP:RELEASE_PRESENTER
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local session = cjson.decode(raw)
if not session.active then return 0 end
return redis.call('DEL', KEYS[2])
`;
```

- [ ] **Step 2: Remove terminal notification from the WebSocket close path.** Call the script with only `connectionId`; do not broadcast `sessionEnded` when the lease is released. Leave `endSession()` and the `/stop` route unchanged.
- [ ] **Step 3: Update the `RELEASE_PRESENTER` fake operation.** It must delete the key only when it still equals the closing connection ID; it must not set `session.active = false` or rewrite the session value.
- [ ] **Step 4: Reject commands before deduplication or enqueue when the presenter lease is absent.** Pass `key(id, 'presenter-lease')` as `KEYS[7]` to `PHONE_COMMAND_SCRIPT`, then add this check after validating the session and phone lease but before setting the command dedupe key:

```lua
if not redis.call('GET', KEYS[7]) then return 'presenter-unavailable' end
```

Update the fake `PHONE_COMMAND` operation to apply the same check before writing a dedupe value or stream event. The existing non-`ok` response path already returns `accepted: false` to the phone.
- [ ] **Step 5: Make presenter replay retention exact.** Change the `MAXLEN ~ 2000` trim to `MAXLEN 2000` in the `PHONE_COMMAND_SCRIPT` and `PUBLISH_EVENT_SCRIPT` writes that can add to `to-presenter`; update the fake Redis stream helper to enforce the same cap. This gives the client dedupe cache a precise replay bound.
- [ ] **Step 6: Run the relay tests and confirm explicit Stop still passes.**

Run: `node --test tests/cloud-remote-redis-server.test.js`

Expected: all relay tests pass, including transient close, no-presenter rejection, stale-close fencing, and explicit Stop.

## Task 3: Add hosted-only retry and duplicate-command tests

**Files:** `tests/mobile-remote-client.test.js`

- [ ] **Step 1: Add an opt-in retry test using `node:test` mock timers.** Verify the default client still does not retry, while a client created with `autoReconnect: true` creates a second socket after a 250 ms transport-close delay.
- [ ] **Step 2: Verify reconnect authentication and latest state.** Publish `{ index: 2, total: 4, busy: false }`, close the first socket, advance the mock clock by 250 ms, open the second socket, and assert it sends the original presenter credential followed by that sanitized state after `presenterReady`.
- [ ] **Step 3: Verify the same command is applied once across reconnect.** Send a `next` command with ID `stable-command`, reconnect, replay the same command, and assert `onCommand` ran once while the second socket receives the cached `commandAck` result. Include a deferred `onCommand` promise case to prove that two copies arriving before completion still call the target once.
- [ ] **Step 4: Verify retry termination.** Assert `already-connected` retries; `invalid-credential`, `session-missing`, `session-ended`, `invalid-session-state`, `sessionEnded`, and explicit `close()` stop timers and create no later socket. Deliver a late open/message/command completion from the old socket and assert it cannot change state or trigger another target action.
- [ ] **Step 5: Run the client tests before implementation.**

Run: `node --test tests/mobile-remote-client.test.js`

Expected: retry and deduplication tests fail because the current client permanently closes after one socket close.

## Task 4: Implement opt-in hosted presenter reconnect

**Files:** `src/mobile-remote-client.js`, `tests/mobile-remote-client.test.js`

- [ ] **Step 1: Add the retry option, timer state, and capped delays.** Keep retries disabled by default so local callers retain current behavior. Emit one `{ type: 'reconnecting' }` event while a retry is pending; report `{ type: 'closed' }` only for a client that will not reconnect or for explicit close.

```js
const RETRY_DELAYS = [250, 500, 1_000, 2_000, 4_000, 5_000];
```

- [ ] **Step 2: On a retryable close, detach the old socket and schedule the next connection.** Keep the current host credential, path, latest sanitized state, and command-result cache in the client closure. Use the retry delay at `Math.min(retryAttempt, RETRY_DELAYS.length - 1)` and increment the attempt after scheduling.
- [ ] **Step 3: Retry `already-connected` without taking over a live lease.** A dropped Vercel function can leave its lease for up to 20 seconds. Retry this result at the same capped interval; let the Redis lease check reject every attempt while another presenter renews it. Stop on missing/ended session, invalid credential, invalid session state, `sessionEnded`, or explicit close. Treat `already-connected` as transient and do not forward it to the app's terminal rejection branch.
- [ ] **Step 4: Fence every socket callback by identity.** Before handling `open`, `message`, or `close`, confirm the callback belongs to the currently selected socket. Async command completion may acknowledge on the currently selected socket, but a stale socket callback must not mutate client state. `close()` marks the client disposed and clears the pending retry timer before closing the socket.
- [ ] **Step 5: Keep command results across socket replacements.** Store a command's pending promise in a `Map` before invoking or awaiting `onCommand`; duplicate IDs await the same result and send its cached acknowledgement without a second target action. Keep at most 2,000 completed/pending command results because presenter event streams are capped at 2,000 entries; evict the oldest entry only after recording the new one. Clear the cache only when the client is explicitly closed or the session ends.
- [ ] **Step 6: Run the client tests.**

Run: `node --test tests/mobile-remote-client.test.js`

Expected: all retry, state replay, dedupe, terminal rejection, and stale-socket tests pass; existing default no-retry tests still pass.

## Task 5: Preserve the cloud workspace during recovery

**Files:** `app.js`, `tests/app.test.js`

- [ ] **Step 1: Add a hosted close test using the existing pairing harness.** Start a cloud session, retain the returned session ID/host credential, close its presenter socket, and assert no `/api/cloud-remote/stop` request was made and the QR/link, phone list, selected target, and Stop control remain available.
- [ ] **Step 2: Assert recovery uses the same session.** Reopen the fake socket and authenticate; assert the existing pairing UI remains visible and the latest sanitized presentation state is published again.
- [ ] **Step 3: Enable reconnect only for the cloud presenter.** Thread `autoReconnect` through `connectMobileRemote()` with a default of `false`; pass `true` from `startCloudMobileRemote()` only. Leave the local `startMobileRemote()` call unchanged.
- [ ] **Step 4: Keep transient status out of the terminal cleanup branch.** Handle the client's reconnecting event with a status such as `Presenter disconnected. Reconnecting…`; do not call `stopMobileRemote()` or clear `cloudRemoteSession`, pairing material, phones, or target. A repeated `authenticated` event after recovery should reuse those values and republish the latest snapshot. Keep `sessionEnded` and permanent rejection terminal.
- [ ] **Step 5: Keep Stop and page-hide cleanup terminal.** Explicit `stopMobileRemote()` and the existing `pagehide` handler must call `client.close()` before posting the cloud `/stop` request, so no retry can reopen an intentionally stopped session.
- [ ] **Step 6: Add local and explicit-stop regressions, then run app tests.**

Run: `node --test tests/app.test.js`

Expected: cloud close preserves and resumes its session; local close keeps the old behavior; explicit Stop and page-hide still call cleanup exactly once.

## Task 6: Validate the hosted recovery path

**Files:** none; verification only.

- [ ] Run focused tests:

```sh
node --test tests/cloud-remote-redis-server.test.js tests/mobile-remote-client.test.js tests/app.test.js
```

- [ ] Run `node --test tests/mobile-remote-phone.test.js` to confirm temporary transport loss still resumes the existing phone credential and does not show terminal re-pair recovery.

- [ ] Run `npm test`, `npm run check`, and `npm run lint`.
- [ ] In Vercel staging with Redis, allow the presenter WebSocket function to hit its timeout. Confirm the same session and QR link recover, old phone credentials still work, a command during a missing presenter lease is rejected, and explicit Stop ends the session.

**Risk boundary:** the fake Redis model does not execute production Lua or lease expiry. Staging is required to verify the actual Vercel timeout path.
