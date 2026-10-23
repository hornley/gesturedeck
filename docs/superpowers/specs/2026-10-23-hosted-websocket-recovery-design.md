# Hosted WebSocket Recovery Design

**Date:** 2026-10-23
**Status:** Approved design; implementation not started
**Related issue:** [#15 — Hosted phone remote ends when Vercel times out its WebSocket](https://github.com/hornley/gesturedeck/issues/15)

## Problem

Hosted phone remote sessions end after roughly 5–10 minutes. Vercel runtime-error aggregation reported `Task timed out after 300 seconds` on `/api/cloud-remote-ws`, which matches the timing. The recorded error was last observed on 2026-10-18 UTC and cannot be tied to the exact session shown in the user's screenshot.

The 300-second function timeout closes a WebSocket connection; it should not end the Redis-backed presentation session. Today, the presenter WebSocket close handler marks the Redis session inactive and broadcasts `sessionEnded`. The phone treats that message as terminal, clears its saved credential, and asks the user to pair again.

The hosted Redis session already has a four-hour lifetime. Its five-minute invite expiry applies to new pairing only. Neither expiry is the cause of an active phone being disconnected after five minutes.

## Goal

Keep one hosted presentation session usable across transient Vercel WebSocket closures. Reconnect the presenter using the same session ID and in-memory host credential, restore the latest validated presenter state, and let paired phones resume with their existing credentials. An explicit presenter Stop remains terminal.

## Scope

- Change the hosted Redis relay and its browser presenter client.
- Preserve the current hosted session lifetime, pairing expiry, credential boundaries, and narrow phone state payloads.
- Reuse the phone's existing bounded reconnect and resume behavior where possible.
- Keep local phone relay behavior unchanged.

Out of scope: replacing Vercel or Redis, making one WebSocket connection last indefinitely, persisting host credentials across a presenter page reload, changing the four-hour session lifetime, or changing invite renewal.

## Design

### Presenter reconnect

- After the presenter has authenticated once, a WebSocket close is treated as a transport interruption. `createMobileRemoteClient` retries the same presenter route with the same session ID and host credential using capped backoff while the session remains valid.
- Seed the client with the initial session state before connecting, then retain the latest sanitized state in memory while disconnected. After re-authentication it republishes that state before phone navigation is re-enabled.
- A retry may encounter the previous presenter's 20-second Redis lease after an abrupt function termination. The authenticated client retries through that lease window. A brand-new presenter connection that is rejected as already connected remains rejected.
- Invalid credentials, an ended or missing session, or invalid session state stop retries and surface the existing rejection guidance. An explicit client close cancels retry timers.
- While reconnecting, the workspace keeps the hosted session, pairing material, and paired-phone list intact and reports a reconnecting status. After re-authentication it refreshes the list and reports the current phone state. It does not call the hosted stop endpoint or discard the host credential.

### Relay session lifecycle

- Closing an authenticated presenter WebSocket releases its presenter lease but leaves the Redis session active until its existing absolute expiry.
- The relay does not broadcast terminal `sessionEnded` for a transient presenter close. Each paired phone receives current presenter availability after pair/resume and whenever it changes through the hosted-only message `{type: 'presenterStatus', available: boolean}`. Phone polling detects a presenter lease that expired after a hard function kill. An unavailable presenter keeps the phone credential valid while the phone shows reconnecting and disables navigation.
- The relay rejects navigation when no presenter lease is active and never queues a command for later execution. A presenter that reconnects starts reading at the current phone-event cursor, so commands from before recovery are not replayed.
- After the presenter re-authenticates and the latest state is accepted, the relay reports availability again and phone controls become usable.
- The existing explicit `/stop` route remains the authoritative terminal action: it marks the session inactive, clears leases, and sends `sessionEnded` to the presenter and phones. Session expiry remains terminal as well.

### Paired phones

- The phone already retries temporary socket closes and sends `resume` with its session-scoped credential. Keep that credential on transient disconnects.
- A transient presenter interruption does not clear phone credentials or show the terminal “presenter ended” message.
- Phone controls are disabled while the presenter is unavailable. A resumed phone receives the latest safe state and current presenter availability, and remains disabled until the presenter is ready.
- Explicit presenter stop, session expiry, and invalid phone credentials continue to clear the saved phone credential and show recovery guidance.

### State and privacy

- Keep host credentials in presenter-page memory. Do not put them in URLs, `localStorage`, logs, or Redis fields beyond the existing hosted session record.
- Continue publishing only the existing validated control state. Local deck/PDF state remains limited to index, total, and busy status. Canva state remains limited to readiness and control status, with no slide position or count.
- Camera frames, hand landmarks, PDFs, filenames, rendered pages, notes, and Canva credentials remain in the presenter browser and never enter relay messages or Redis.
- Do not extend the four-hour `expiresAt` during reconnect. The five-minute pairing invite and twenty-second presenter lease keep their current meanings.

## Affected code and tests

- `src/mobile-remote-client.js`: reconnect after an established socket closes, retain the latest state, and cancel retries on explicit close or terminal rejection.
- `app.js`: distinguish transient reconnecting from terminal stop so hosted session state and pairing material survive.
- `src/cloud-remote-redis-server.js`: release the presenter lease without ending the Redis session; communicate presenter availability; reject commands while unavailable; preserve `/stop` as terminal.
- `src/mobile-remote-phone.js`: consume presenter availability and disable/restore controls while retaining existing phone resume behavior.
- `tests/mobile-remote-client.test.js`, `tests/app.test.js`, `tests/cloud-remote-redis-server.test.js`, and, if phone protocol behavior changes, `tests/mobile-remote-phone.test.js`.

No extension protocol, local relay, server asset allowlist, or Vercel build-copy changes are expected.

## Acceptance criteria

1. Simulating a Vercel-style close after presenter authentication leaves the hosted Redis session active and does not send terminal `sessionEnded` to phones.
2. The presenter automatically reconnects to the same session, re-authenticates with the same in-memory credential, and republishes its latest sanitized state.
3. A paired phone retains its credential across transient disconnects, resumes without a new QR scan, and displays the current state after recovery.
4. Phone commands cannot be accepted or queued while the presenter lease is absent, and commands from before recovery are not replayed; controls are visibly disabled during that interval.
5. Explicit Stop cancels presenter retries, invokes the existing stop route, ends the session, notifies phones, and makes later resume fail terminally.
6. Expired sessions and authentication/state rejection stop retries and use existing recovery guidance.
7. Canva payload validation and the camera/PDF privacy boundary remain unchanged.

## Verification

- Unit tests cover a transient presenter close followed by successful authentication, latest-state publication, phone resume, and a separate explicit-stop path.
- Tests confirm an unavailable presenter cannot accumulate navigation commands for later execution.
- Run focused Node tests, then `npm run check` and `npm run lint`; run `npm test` because this change crosses the app, client, relay, and phone protocol.
- After deployment, keep a paired session open for at least 11 minutes, navigate after the first 300-second connection timeout, verify the phone recovers without pairing again, then verify explicit Stop ends the session.

The Redis tests use a fake Redis model and do not execute the production Lua scripts. They cannot prove Vercel's function-timeout behavior, so the deployed smoke test is required.

## Risks

- A reconnect can take up to the existing presenter lease expiry after a hard function kill; phone navigation stays disabled until recovery completes.
- If the four-hour session expires or the presenter page reloads and loses its in-memory host credential, the session cannot be resumed and must be started again.
- Reconnection reduces the impact of Vercel's function limit but does not make a WebSocket connection permanent; each connection may still be closed by the platform.
