# Hosted Canva Session Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make fresh Redis-backed Canva sessions authenticate reliably on Vercel, return safe and distinct rejection reasons, and never expose credentials for a session Redis did not create.

**Architecture:** Keep Redis as the shared Vercel session store. Return an explicit status envelope from the presenter-auth Lua script, canonicalize Canva state at the Redis boundary, and validate that envelope before the WebSocket handler accepts the presenter. Make session creation retry a small number of Redis `SET NX` collisions and return credentials only after Redis confirms a write.

**Tech Stack:** Node.js ES modules, Upstash Redis Lua scripts, `node:test`, `ws`, Vercel functions.

---

## File map

- Modify `src/cloud-remote-redis-server.js`: Redis session creation, presenter-auth Lua result contract, Canva-state normalization, and safe wire rejection reasons.
- Modify `tests/cloud-remote-redis-server.test.js`: extend the in-memory Redis model and cover auth outcomes, Canva serialization shapes, and `SET NX` results.
- Modify `app.js` and `tests/app.test.js`: show distinct safe presenter rejection messages for the new wire reasons.
- Create `docs/superpowers/plans/2026-10-18-hosted-canva-session-auth.md`: this execution plan.

Scope invariant: do not change phone payloads, extension behavior, Redis environment variables, or Vercel deployment settings.

## Task 1: Add Redis-relay regression coverage

**Files:**
- Modify: `tests/cloud-remote-redis-server.test.js`

- [ ] Add an optional initial state and scripted `SET` results to `MemoryRedis`/`createFixture`, retaining the existing PDF defaults. Count `SET` calls so retry behavior is observable.
- [ ] Update the fake `PRESENTER_AUTH` operation to model the explicit JSON result envelope. Model the outcomes as `{ status: 'missing' }`, `{ status: 'ended' }`, `{ status: 'invalid' }`, `{ status: 'occupied' }`, and `{ status: 'ok', state }`; publish the canonical Canva state when the state target is Canva.
- [ ] Add focused tests for a fresh Canva session with `ready: false` and `ready: true`, using both `index`/`total: null` and omitted positions in the auth result. Assert authentication succeeds and any state published for Canva has exactly `target`, `ready`, `index: null`, `total: null`, and `busy: false`.
- [ ] Add one table-driven presenter-auth test for missing session, ended session, wrong credential, occupied lease, and malformed/invalid state output. Assert each rejection reason is distinct and no raw result is sent.
- [ ] Add start-route tests where the first `SET NX` returns `null` and the second succeeds, and where all three bounded attempts fail. Assert the successful response follows the successful write and the failed response is `503` with only `{ error: 'relay-storage-unavailable' }` and no pairing credentials.
- [ ] Run `node --test tests/cloud-remote-redis-server.test.js` and confirm the new behavior tests fail before the implementation changes.

The Canva auth result parser must accept the following Redis serialization shapes and produce one canonical state:

```js
{ target: 'canva', ready: true, busy: false, index: null, total: null }
{ target: 'canva', ready: true, busy: false }
// canonical output:
{ target: 'canva', ready: true, index: null, total: null, busy: false }
```

It must reject non-null positions, non-boolean readiness, `busy: true`, and unexpected fields.

## Task 2: Implement explicit Redis auth outcomes and Canva normalization

**Files:**
- Modify: `src/cloud-remote-redis-server.js`

- [ ] Change `PRESENTER_AUTH_SCRIPT` to return JSON objects with an explicit `status`: `missing`, `ended`, `invalid`, `occupied`, `invalid-state`, or `ok`. For success, include `state`. Never return arbitrary Redis values as browser-visible text.
- [ ] For Canva state in the Lua script, allow only `target`, `ready`, `busy`, `index`, and `total`; require a boolean `ready`, `busy == false`, and positions either absent or `cjson.null`. Rebuild the outgoing state with both positions set to `cjson.null`, preserving readiness and the narrow payload. Keep PDF state unchanged.
- [ ] Add a presenter-auth result parser that accepts a decoded object or JSON object string, validates the exact envelope shape, normalizes Canva state, and returns `invalid-state` for malformed, unknown, or invalid results. Do not change `sanitizeState` for normal presenter updates or phone input.
- [ ] Map Lua statuses to safe protocol reasons: `missing` to `session-missing`, `ended` to `session-ended`, `invalid` to `invalid-credential`, `occupied` to the existing `already-connected`, and every invalid-state result to `invalid-session-state`.
- [ ] On the `start` route, try at most three newly generated session IDs and accept only a Redis `SET ... NX` result of `'OK'`. On three misses, return `503` `{ error: 'relay-storage-unavailable' }` without credentials or invite material.
- [ ] Run `node --test tests/cloud-remote-redis-server.test.js` and confirm the regression coverage passes.

The auth-result handling contract is:

```js
const AUTH_REASONS = {
  missing: 'session-missing',
  ended: 'session-ended',
  invalid: 'invalid-credential',
  occupied: 'already-connected',
  'invalid-state': 'invalid-session-state',
};
```

Only `status: 'ok'` with a valid normalized state authenticates the presenter.

## Task 3: Give the presenter safe, reason-specific status copy

**Files:**
- Modify: `app.js`
- Modify: `tests/app.test.js`

- [ ] Replace the nested rejection ternary in `handleMobileRemoteConnection` with an explicit safe message map for `already-connected`, `invalid-credential`, `session-missing`, `session-ended`, and `invalid-session-state`; retain the generic fallback for unknown reasons.
- [ ] Extend the existing rejection cases in `tests/app.test.js` to assert the new copy and preserve the unknown/missing-reason fallback.
- [ ] Run `node --test tests/app.test.js`.

## Task 4: Run repository validation and inspect the final diff

**Files:**
- Review all implementation and test changes from Tasks 1–3.

- [ ] Run `node --test tests/cloud-remote-redis-server.test.js`.
- [ ] Run `npm run check`.
- [ ] Run `npm run lint`.
- [ ] Run `npm test` because the change crosses the cloud relay and presenter protocol.
- [ ] Review `git diff --check` and the complete diff. Preserve the unrelated untracked `docs/pricing-strategy.md`.
- [ ] Commit the implementation, push `codex/fix-hosted-canva-session-auth`, open a PR against `main`, and link the PR to this T3 thread immediately after creation.
- [ ] Use the Vercel preview deployment to repeat the hosted checks for one PDF session and Canva sessions at both readiness values. Report the test-double boundary separately from live Vercel results.

## Self-review

- Spec coverage: Redis write confirmation and bounded collision retries are in Task 2 and tested in Task 1; distinct auth outcomes and safe reasons are in Tasks 1–3; Canva normalization and narrow state are in Tasks 1–2; PDF regression, full local checks, PR creation, and hosted preview checks are in Task 4.
- Placeholder scan: no `TODO`, `TBD`, or unspecified implementation steps remain; all test commands and status contracts are named.
- Type and contract consistency: Lua uses the statuses in `AUTH_REASONS`; the fake Redis model returns the same envelope; the WebSocket handler maps the envelope to the reason strings handled by `app.js`.
