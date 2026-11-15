# Issue #18 — Hosted Session Recovery and Camera Removal

- **Issue:** [hornley/GestureDeck#18](https://github.com/hornley/GestureDeck/issues/18)
- **Design status:** Approved
- **Baseline:** `hornley/main` at `4070ff4` (`Make Canva presentation routes phone-ready by URL`)

## Context

Issue #18 tracks two findings: an unexpected presenter WebSocket close ends a hosted phone session, and camera assets remain in the Vercel output after the camera feature was removed in the previously reviewed branch.

The issue-linked branch is based on `hornley/main`, where camera capture is still active: `app.js` imports the camera and gesture modules, and `workspace.html` contains camera setup, preview, diagnostics, and gesture settings. Removing only the deployment assets would break that baseline. This design therefore includes the previously requested removal of camera capture and advanced gesture settings, followed by removal of their production assets.

The historical root [`spec.md`](../../../spec.md) remains unchanged. It describes an earlier camera-first proposal and is not the current product specification.

## Goals

1. Recover a hosted session after a transient presenter WebSocket disconnect without requiring phones to pair again.
2. Remove camera capture and gesture controls from the presenter workspace, then exclude the unused camera runtime from Vercel output.
3. Preserve explicit session stop, current connection fencing, narrow remote payloads, and keyboard, phone, PDF, and Canva presentation paths.

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
- Keep session data limited to the current navigation state, readiness, phone metadata, and pairing credentials. Do not add camera frames, PDF data, rendered slides, or Canva credentials to Redis or phone messages.

## Camera and deployment behavior

- The presenter workspace does not request camera permission or call `getUserMedia`.
- Remove camera setup/start/pause/resume controls, camera selection and preview, capture status, hand diagnostics, gesture guidance, gesture mapping controls, and advanced gesture settings.
- Remove camera and gesture imports, capture lifecycle, and inference calls from the workspace entry point. The camera APIs are never invoked by the running app.
- Delete the unused bundled hand-landmarker model from `assets/` so it is absent from both the Vercel output and local development server.
- Preserve manual slide controls, keyboard navigation, sample deck and PDF presentation, phone pairing, and Canva extension control.
- Update the landing page and README so they no longer advertise camera gestures or describe local camera setup and MediaPipe as current product behavior. Keep the root historical `spec.md` intact.
- The Vercel output contains no hand-landmarker model, MediaPipe runtime/WASM, or camera/gesture browser modules. Keep the PDF.js and phone/Canva assets the current product needs.
- Remove MediaPipe from production dependencies. It may remain a development dependency while existing module-level tests need its package files; it must not be shipped to the hosted runtime or copied to `dist/`.
- Remove the MediaPipe path from the local development server's public asset allowlist if the workspace no longer requests it. Preserve the server's explicit allowlist and realpath checks.

## Scope and affected files

- **Hosted reconnect:** `src/cloud-remote-redis-server.js`, `src/mobile-remote-client.js`, `app.js`, `src/mobile-remote-phone.js`, and focused tests under `tests/`.
- **Camera removal:** `app.js`, `workspace.html`, `styles.css`, `index.html`, `README.md`, and camera-related assertions in `tests/app.test.js`.
- **Deployment cleanup:** `scripts/build-vercel.mjs`, `package.json`, `package-lock.json`, and the selected dependency paths in `server.mjs`.
- Keep the mobile phone server's separate asset allowlist and realpath check intact.
- Keep the Canva extension protocol, PDF presentation flow, local phone relay, phone limit, Redis session schema boundaries, and local-network security checks unchanged.

## Acceptance criteria

1. An unexpected hosted presenter socket close leaves the session active and paired phone credentials valid.
2. The hosted presenter retries the same session, restores current navigation state, and resumes phone control without new pairing, including after a stale lease expires.
3. An obsolete connection cannot change state or clear a newer presenter lease; an actively renewed lease is never taken over.
4. The presenter keeps the pairing link and controls visible during transient recovery. Phones never present the transient loss as a terminal session end and do not claim navigation succeeded without a current presenter lease.
5. Explicit Stop and page-hide cleanup still end the session, revoke credentials, and deliver `sessionEnded`; phones then require a new pairing.
6. The workspace has no camera capture UI or gesture settings and does not request camera permission; the model asset is absent; keyboard, phone, PDF, and Canva controls still work.
7. `npm run build:vercel` produces a `dist/` without the hand model, MediaPipe files, or camera/gesture modules, while retaining PDF.js and required remote assets.
8. README and landing-page copy match the camera-free workspace.
9. Automated tests cover transient reconnect separately from explicit stop, confirm camera-free workspace behavior, and guard the Vercel output against stale camera assets.

## Validation

- Run the focused hosted-relay, presenter-client, phone-client, workspace, and build-output tests.
- Run `npm test`, `npm run check`, `npm run lint`, and `npm run build:vercel`.
- Inspect `dist/` for the removed camera/model/WASM paths and confirm required PDF/remote assets remain.
- Verify on a Vercel staging deployment with Redis that the presenter can survive a WebSocket function timeout and that phones recover without pairing again. The fake Redis tests do not execute production Lua or establish Vercel timeout behavior.

## Risks and limits

- A presenter that never reconnects leaves the session available only until its existing expiry. The Stop action remains available to an open presenter page.
- Retry logic must stop on explicit end and must not bypass presenter lease checks or origin/credential validation.
- The Redis test double models script behavior; production Redis and a real Vercel timeout require staging verification.
- Camera module tests may remain as development-only tests. Their assets and modules must not re-enter the Vercel output.

## Non-goals

- Change the phone limit, session/invite lifetime, local remote behavior, Redis data contract, or Canva protocol.
- Reintroduce camera capture, gesture controls, or advanced settings.
- Rewrite the historical root `spec.md` or add new presentation targets.
