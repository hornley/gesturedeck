# Issue #18 — Hosted Session Recovery

- **Issue:** [hornley/GestureDeck#18](https://github.com/hornley/GestureDeck/issues/18)
- **Design status:** Approved
- **Baseline:** `hornley/main` at `4070ff4` (`Make Canva presentation routes phone-ready by URL`)

## Context

Issue #18 tracks an unexpected presenter WebSocket close ending a hosted phone session.


## Goals

1. Recover a hosted session after a transient presenter WebSocket disconnect without requiring phones to pair again.
2. Preserve explicit session stop, current connection fencing, narrow remote payloads, and keyboard, phone, PDF, and Canva presentation paths.

## Hosted session behavior

### Transient disconnect

- An unexpected close of the hosted presenter WebSocket releases that connection's lease only. It does not set the Redis session inactive, revoke phone credentials, clear the pairing session, or broadcast the terminal `sessionEnded` event.
- The hosted presenter client reconnects to the same session using its in-memory session ID and host credential. It retries with the phone client's capped backoff until it reconnects, the session expires, authentication is permanently rejected, or the presenter explicitly stops. A temporary `already-connected` rejection from a stale 20-second lease is retryable; the client must not take over an actively renewed lease.
- A fresh connection ID and lease fence every reconnected presenter. A late close or message from an older connection must not release or mutate the current connection.
- The presenter page preserves its cloud session, pairing link, phone list, and target while retrying. It does not call the stop endpoint or reset pairing UI on a transient close.
- After authentication, the presenter republishes its latest sanitized presentation state. Existing phone IDs and credentials remain valid; phone clients continue their existing resume behavior and do not require a new QR code.
- While the presenter is unavailable, phone navigation must not be reported as accepted unless a current presenter lease can process it. Phones remain in the same session and recover when the presenter reconnects; they must not show the terminal re-pair flow.
- Show a temporary reconnecting state in the presenter workspace. Keep the session's Stop/Disconnect action available during recovery.
- Limit this automatic retry behavior to the hosted cloud presenter path. Local presenter disconnect behavior remains unchanged.

### Explicit end and expiry

- The presenter's explicit Stop/Disconnect action, including the existing page-hide cleanup request, remains terminal. It invalidates the session and phone credentials and sends `sessionEnded` to paired phones.
- A terminal `sessionEnded` response, invalid host credential, or expired/missing session stops automatic retries. A genuinely temporary transport close is retryable.
- Keep the existing session and invite lifetimes. Do not extend them to compensate for disconnect recovery.
- Keep session data limited to the current navigation state, readiness, phone metadata, and pairing credentials. Do not add PDF data, rendered slides, or Canva credentials to Redis or phone messages.

## Scope and affected files

- **Hosted reconnect:** `src/cloud-remote-redis-server.js`, `src/mobile-remote-client.js`, `app.js`, `src/mobile-remote-phone.js`, and focused tests under `tests/`.
- Keep the mobile phone server's separate asset allowlist and realpath check intact.
- Keep the Canva extension protocol, PDF presentation flow, local phone relay, phone limit, Redis session schema boundaries, and local-network security checks unchanged.

## Acceptance criteria

1. An unexpected hosted presenter socket close leaves the session active and paired phone credentials valid.
2. The hosted presenter retries the same session, restores current navigation state, and resumes phone control without new pairing, including after a stale lease expires.
3. An obsolete connection cannot change state or clear a newer presenter lease; an actively renewed lease is never taken over.
4. The presenter keeps the pairing link and controls visible during transient recovery. Phones never present the transient loss as a terminal session end and do not claim navigation succeeded without a current presenter lease.
5. Explicit Stop and page-hide cleanup still end the session, revoke credentials, and deliver `sessionEnded`; phones then require a new pairing.

## Validation

- Run the focused hosted-relay, presenter-client, phone-client, workspace, and build-output tests.
- Run `npm test`, `npm run check`, `npm run lint`, and `npm run build:vercel`.
- Verify on a Vercel staging deployment with Redis that the presenter can survive a WebSocket function timeout and that phones recover without pairing again. The fake Redis tests do not execute production Lua or establish Vercel timeout behavior.

## Risks and limits

- A presenter that never reconnects leaves the session available only until its existing expiry. The Stop action remains available to an open presenter page.
- Retry logic must stop on explicit end and must not bypass presenter lease checks or origin/credential validation.
- The Redis test double models script behavior; production Redis and a real Vercel timeout require staging verification.

## Non-goals

- Change the phone limit, session/invite lifetime, local remote behavior, Redis data contract, or Canva protocol.
