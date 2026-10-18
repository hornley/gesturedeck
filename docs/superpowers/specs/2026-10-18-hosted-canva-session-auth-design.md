# Hosted Canva Session Authentication Design

**Status:** Ready for review

**Date:** 2026-10-18

## Goal

Make a fresh hosted Canva session authenticate reliably and report the actual presenter-auth failure category. Keep Redis as the shared session store for Vercel's separate HTTP and WebSocket functions.

## Reproduction and current behavior

- The current production deployment returns a successful response when creating fresh local/PDF and Canva sessions.
- Fresh local/PDF sessions authenticated in two live checks. Fresh Canva sessions were rejected in two live checks, both with Canva readiness false and true.
- The hosted relay stores state in Redis. The start API and presenter WebSocket run as separate Vercel functions and both use the same Redis integration.
- The start handler calls Redis `SET NX` but ignores its result before returning the session ID and host credential.
- The presenter auth script returns serialized session state on success and string statuses for missing, ended, invalid-credential, or occupied sessions. The handler currently maps any unparseable result other than occupied to `invalid-credential`; this also hides state parsing failures.
- Canva state carries `target: "canva"`, a boolean `ready`, `busy: false`, and null slide index/count. Redis/Lua serialization must preserve or safely normalize those null fields.

## Approaches considered

1. **Keep Redis and fix the Canva auth path (selected):** Check that Redis accepted session creation, normalize Canva state after Redis/Lua serialization, and keep auth statuses separate from state parsing. This addresses the live Canva-only failure while preserving cross-function session sharing.
2. **Add diagnostics without fixing state handling:** Preserve separate failure reasons and use a later deployment to gather more evidence. This would leave the reproduced Canva flow broken for at least one deployment cycle.
3. **Revert to the old in-memory relay:** This avoids Redis/Lua state serialization, but Vercel's start and WebSocket requests run in separate function instances. They cannot reliably share in-memory sessions, so this is not suitable for production.

## Design

### Session creation

- Generate a new session ID and attempt `SET` with `NX` and the existing four-hour TTL.
- Return pairing credentials only when Redis confirms the write succeeded.
- If `NX` reports an existing key, generate a new ID and retry a small bounded number of times. If no write succeeds, return the existing generic storage-unavailable response and do not return session credentials.
- Do not expose Redis responses, session IDs, credentials, or invites in errors or logs.

### Presenter authentication and Canva state

- Have the presenter auth script return an explicit outcome and state, keeping `missing`, `ended`, `invalid` credential, and `occupied` lease outcomes distinct from a successful state result.
- Canonicalize valid Canva state after reading the script result. Require `target: "canva"`, a boolean `ready`, and `busy: false`; accept `index` and `total` when null or omitted by serialization and normalize both to null. Reject non-null slide positions and unrelated fields.
- Keep the externally published Canva state narrow: readiness only, with null index/count and `busy: false`.
- Report state-result parsing/validation failure separately from missing, ended, or mismatched credentials. Preserve the existing `already-connected` category for an occupied presenter lease.
- Keep rejection messages safe and actionable. Never send raw Redis results or arbitrary script output to the browser.

### Tests and boundaries

- Extend `tests/cloud-remote-redis-server.test.js` to cover fresh Canva authentication for both readiness values, explicit auth statuses, serialization with omitted/null Canva positions, and failed/colliding `SET NX` results.
- Update focused UI tests only if the reason-specific presenter copy changes.
- Do not change phone payload scope, extension behavior, Redis environment variables, or deployment protection settings.
- Do not add automatic presenter reconnects or revert to in-memory Vercel sessions.

## Acceptance criteria

1. Fresh local/PDF sessions continue to authenticate through the Vercel HTTP and WebSocket functions.
2. Fresh Canva sessions authenticate for both ready and not-ready states, and the resulting state remains limited to readiness with null position/count.
3. The start API never returns credentials unless the Redis session write succeeded.
4. Missing session, ended session, credential mismatch, occupied lease, and invalid auth-state output remain distinguishable without exposing raw server data.
5. A focused Redis-relay regression test covers the Lua/Redis result contract, and hosted Vercel checks separately verify the deployed path.
6. The old in-memory relay is not restored for Vercel.

## Validation expectations

- Run the focused Redis relay test, `npm run check`, and `npm run lint`; run `npm test` because this fix crosses the cloud relay and presenter UI protocol.
- Treat the test double as coverage of the local contract only; it does not execute the production Lua scripts or prove Redis/Vercel behavior.
- After a preview deployment, verify a fresh PDF session and fresh Canva sessions in both readiness states using the hosted origin.
- Report the live production result separately from local test-double coverage. Do not treat the existing live smoke check as proof that the Canva path works; it is the failing reproduction this change must resolve.

## Design self-review

- Scope stays within Redis session creation, presenter auth result handling, Canva state normalization, and focused regression coverage.
- The design does not assume that the reported `invalid-credential` string proves a credential mismatch.
- The session store remains shared across Vercel functions, and the outgoing Canva payload remains limited to readiness.
- Production checks avoid exposing credentials and leave deployment protection and environment settings untouched.
