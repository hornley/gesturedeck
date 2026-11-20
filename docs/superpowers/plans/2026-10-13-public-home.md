# GestureDeck Public Home and Cloud Phone Remote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a public home page and make its cloud presentation path control PDFs in the presenter’s browser from a phone over the internet.

**Architecture:** Keep the current browser workspace at `workspace.html` and use `index.html` for the public home. Add an in-memory cloud session manager beside the local-network relay, reusing the validated pairing protocol. A cloud mode in the workspace uses same-origin HTTP and WebSocket routes; local pairing remains available.

**Tech Stack:** Semantic HTML, CSS, vanilla JavaScript modules, Node.js HTTP server, existing WebSocket and mobile-remote session helpers.

---

## File map

- `index.html` — public home page; its main action opens the cloud workspace.
- `workspace.html` — existing presenter workspace; keep all current control IDs and add a cloud-only UI mode.
- `home.css` — new public home page styles and slide/phone preview.
- `server.mjs` — allow the home, workspace, and phone page assets; attach the cloud relay; allow same-origin secure WebSocket connections.
- `src/cloud-remote-server.js` — in-memory multi-session cloud relay with same-origin APIs, pairing, session expiry, and active-session cap.
- `src/mobile-remote-client.js` — support a configurable WebSocket path for the cloud presenter session while retaining the local path default.
- `src/mobile-remote-phone.js` — read the cloud session identifier from the short `/r/<id>` path and connect to its cloud session; keep the current path for local pairing.
- `app.js` — select local or cloud phone pairing based on `experience=cloud`; route start, renewal, and stop to the correct service.
- `mobile-remote.html` — use phone-remote wording that applies to local and cloud modes.
- `README.md` — document local and hosted phone pairing, session limits, and deployment requirements.
- `docs/superpowers/specs/2026-10-13-public-home-design.md` — approved landing page scope.
- `docs/superpowers/specs/2026-10-13-cloud-phone-remote-design.md` — cloud relay design, privacy, session, and security limits.

## Task 1: Move the existing workspace and allow the public pages

**Files:**
- Rename: `index.html` to `workspace.html`
- Modify: `workspace.html`
- Modify: `server.mjs`

- [x] Preserve the existing workspace markup and control IDs by renaming the current `index.html` to `workspace.html`.
- [x] Keep its stylesheet and module paths unchanged so root-relative assets continue to load.
- [x] Set the workspace title and description for sample-deck/PDF presenting, and change the brand link to `/`.
- [x] Allow `workspace.html`, `home.css`, `mobile-remote.html`, and `mobile-remote.css` in `publicRootFiles` without changing existing path traversal checks or response headers.

## Task 2: Add the public home page

**Files:**
- Create: `index.html`
- Create: `home.css`

- [x] Add the “The floor is yours” hero, concise PDF plus phone copy, and one prominent “Start presenting” action to `/workspace.html?experience=cloud`.
- [x] Add a CSS-built slide and phone preview, marked decorative to assistive technology.
- [x] Add “Choose a PDF”, “Connect your phone”, and “Present” steps.
- [x] State that the PDF stays in the presenter’s browser and the cloud carries pairing and slide controls only.
- [x] Add responsive styles, focus states, and reduced-motion handling without external assets.
- [ ] Check 320px layout for horizontal overflow and ensure text/actions remain readable.

## Task 3: Add the cloud session relay

**Files:**
- Create: `src/cloud-remote-server.js`
- Modify: `server.mjs`
- Reference: `src/mobile-remote-session.js`
- Reference: `src/websocket.js`

- [x] Create a `Map` of active sessions keyed by a cryptographically random identifier; each value wraps one `createMobileRemoteSession()` instance.
- [x] Add same-origin `POST` endpoints to start, renew, and stop a session. Validate the exact `Origin` host against the request host, parse JSON with a 16 KiB body limit, validate the slide snapshot, and require the session’s presenter credential for renewal and stop.
- [x] Require HTTPS for cloud session creation; return a stable `https-required` error on public HTTP origins.
- [x] Create a compact phone URL from the validated request origin, `/r/<id>#<one-use-invite>`; use a cryptographically random 96-bit session identifier so the link fits the existing QR generator, and keep the invite in the fragment.
- [x] Add `/ws/cloud-remote/presenter?session=<id>` and `/ws/cloud-remote/phone?session=<id>` handlers on the main server. Require same-origin WebSocket upgrades, authenticate the presenter before relaying state, and delegate pairing/resume/commands to the existing mobile-remote session helper.
- [x] Keep the 120-second invite TTL and five-attempt limit from `createMobileRemoteSession`; permit one phone per session and cap unauthenticated pending phone sockets per session at eight.
- [x] Stop and remove a session when the presenter disconnects or posts stop; also expire it after four hours.
- [x] Attach and close the cloud relay in `server.mjs` without breaking the existing local relay or static file handler.
- [x] Extend the existing Content Security Policy only for same-site HTTP requests and same-host `ws:`/`wss:` traffic needed by the two remote paths.

## Task 4: Connect the cloud mode to the presenter and phone pages

**Files:**
- Modify: `app.js`
- Modify: `src/mobile-remote-client.js`
- Modify: `src/mobile-remote-phone.js`
- Modify: `workspace.html`
- Modify: `styles.css`
- Modify: `mobile-remote.html`

- [x] In cloud mode, connect the existing phone button to `/api/cloud-remote/start`; show the returned QR/link and existing pairing status inside the pairing dialog.
- [x] Route new-link and stop actions to the cloud endpoints and include the in-memory session ID and presenter credential; use `keepalive` on page exit.
- [x] Add a configurable WebSocket path to `createMobileRemoteClient`, defaulting to its current local path; pass the cloud session path only in cloud mode.
- [x] In `mobile-remote-phone.js`, read the cloud session ID from `/r/<id>` and connect to `/ws/cloud-remote/phone?session=<id>`; otherwise use the existing local phone WebSocket path.
- [x] Keep the pairing invite in the URL fragment and preserve existing phone credential session-storage behavior.
- [x] Replace the phone page’s “LOCAL REMOTE” and trusted-Wi-Fi-only wording with brief neutral “PHONE REMOTE” copy that fits both transports.
- [x] Treat `experience=cloud` as cloud mode only for non-local hostnames; on localhost, private IPv4, and `.local` hosts keep the reachable local pairing flow.

## Task 5: Document local and hosted operation

**Files:**
- Modify: `README.md`

- [x] Document HTTPS and WebSocket upgrade requirements for a hosted instance, one Node process, in-memory sessions, the four-hour session cap, 64-session process cap, and one phone per session.
- [x] Keep the existing same-network pairing steps under a local-remote heading and avoid implying local HTTP traffic is encrypted.

## Task 6: Review the end-to-end experience

**Files:**
- Review: `index.html`, `home.css`, `workspace.html`, `styles.css`, `app.js`
- Review: `server.mjs`, `src/cloud-remote-server.js`, `src/mobile-remote-client.js`, `src/mobile-remote-phone.js`, `mobile-remote.html`

- [ ] Open `/` and review the public home at desktop and 320px widths; verify the one primary action, privacy copy, visible focus, and absence of horizontal overflow.
- [ ] Start the cloud phone session; confirm the QR/link uses the current site origin and is HTTPS on a secure deployment.
- [ ] Open the link in a second browser context and confirm it pairs, shows slide position, and advances and reverses the presenter’s sample deck or PDF.
- [ ] Stop the presenter session and confirm the phone disconnects. Confirm a restarted server has no prior active session.
- [ ] Do not add or run automated tests unless requested.

## Self-review

- The home page requirements map to Tasks 1, 2, and 5.
- PDF privacy, secure pairing, session lifetime/cap, cloud-only mode, and local-mode preservation map to Tasks 3–5.
- The relay reuses existing invite authentication, validation, state and command handling instead of creating a second protocol.
- No automated tests are added or run; validation is limited to manual review after implementation.
