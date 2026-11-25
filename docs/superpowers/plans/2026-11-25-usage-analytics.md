# Usage Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven development to implement this plan task by task, with review between tasks. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the owner public-site traffic metrics and an authenticated view of aggregate PDF, phone, and presentation-use metrics without sending presentation content off-device.

**Architecture:** Use Vercel Web Analytics for anonymous production page views and visitors. Use a same-origin Vercel function and the existing Upstash Redis for allowlisted feature events, atomic per-session deduplication, daily aggregates, and password-protected summaries. Add a static `/analytics` page whose data API requires an owner password.

**Tech Stack:** Vanilla JavaScript ES modules, Node.js HTTP/Vercel functions, `@vercel/analytics`, Upstash Redis Lua scripts, `node:test`.

**Approved specification:** [2026-11-25 usage analytics design](../specs/2026-11-25-usage-analytics-design.md). The user approved the design in chat and invoked `$workflow-plan` after receiving the committed spec on 2026-11-25.

**Plan status:** Planning complete; implementation has not started.

---

## File map

- `src/redis-client.js` — shared Upstash client factory, preserving both current environment-variable name pairs.
- `src/cloud-remote-redis-server.js` — use the shared factory without changing relay behavior.
- `src/usage-analytics-server.js` — strict event API, session and daily Redis writes, summary reads, password login/logout, cookie validation.
- `api/usage-analytics.js` — Vercel function adapter for the analytics server module.
- `src/usage-analytics-client.js` — short-lived session ID, event allowlist, and best-effort same-origin event delivery.
- `src/site-analytics.js` — call Vercel Web Analytics from landing and workspace pages without adding inline script.
- `analytics.html`, `analytics.css`, `analytics.js` — public static shell, password form, and authenticated 7/30/90-day feature summary view.
- `app.js` — emit events only after a PDF is rendered, a phone joins, a phone command succeeds, or a connected presentation ends.
- `index.html`, `workspace.html` — load the Vercel page-view integration and disclose anonymous analytics; do not load tracking on the analytics or phone-remote page.
- `vercel.json` — route `/analytics` and analytics API actions to their static page and Vercel function.
- `server.mjs` — allow the new static page/assets through its existing explicit allowlist and map `/analytics` locally.
- `scripts/build-vercel.mjs` — copy the analytics page, client modules, and browser entry for `@vercel/analytics` into `dist/`.
- `package.json`, `package-lock.json` — add the Vercel Analytics dependency and include new JavaScript files in `npm run check`.
- `tests/usage-analytics-server.test.js` — event validation, deduplication, aggregation, retention, login, cookie, and unavailable-Redis behavior.
- `tests/usage-analytics-client.test.js`, `tests/app.test.js` — event payload safety and event trigger boundaries.
- `tests/server.test.js` — ensure `/analytics` and its static assets are served through the allowlist, and page-view tracking is included only on public pages.
- `README.md` — explain what analytics is collected, where it appears, setup secrets, retention, and the hosted-only measurement boundary.

## Tasks

### Task 1: Add shared Redis construction and tested aggregate tracking

**Files:**
- Create: `src/redis-client.js`
- Modify: `src/cloud-remote-redis-server.js`
- Create: `src/usage-analytics-server.js`
- Test: `tests/usage-analytics-server.test.js`

- [ ] **Step 1: Add failing tests for the event contract and counters.**

Use an injected fake Redis model and a fixed clock. Send these events with the same valid UUID session ID, advancing the clock by 120 seconds between the phone connection and session end:

```js
const sessionId = '550e8400-e29b-41d4-a716-446655440000';
const events = [
  { event: 'pdf_imported', sessionId },
  { event: 'pdf_imported', sessionId },
  { event: 'phone_connected', sessionId },
  { event: 'phone_navigation', sessionId },
  { event: 'session_ended', sessionId },
  { event: 'session_ended', sessionId },
];

let now = Date.UTC(2026, 10, 25);
let connectedAt = now;
for (const event of events) {
  if (event.event === 'phone_connected') connectedAt = now;
  if (event.event === 'session_ended') now = connectedAt + 120_000;
  await trackUsageEvent(redis, { ...event, now });
}
```

Assert `summary.totals` equals:

```js
{
  pdfImports: 1,
  phoneConnectedSessions: 1,
  pdfAndPhoneSessions: 1,
  phoneNavigationSessions: 1,
  completedPresentations: 1,
  presentationSeconds: 120,
  averagePresentationSeconds: 120,
}
```

Also reject extra fields, unknown event names, malformed session IDs, and client-supplied duration values. Advance the fake clock beyond four hours and assert the recorded duration is capped at `14_400`; move it backwards and assert duration is `0`. The fake Redis must model the Lua behavior atomically; it does not execute production Lua.

- [ ] **Step 2: Run the new tests and confirm they fail for the missing analytics store.**

Run:

```sh
node --test tests/usage-analytics-server.test.js
```

Expected: FAIL because `trackUsageEvent` and `readUsageSummary` do not exist yet.

- [ ] **Step 3: Extract the existing Upstash environment lookup.**

Create `src/redis-client.js` with this implementation and keep current aliases:

```js
import { Redis } from '@upstash/redis';

export function createRedisClient(env = process.env) {
  const url = env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}
```

Replace the local `makeRedis` implementation in `src/cloud-remote-redis-server.js` with an import of `createRedisClient()` as its default Redis factory. Preserve the injected `redis` option and all existing relay behavior.

- [ ] **Step 4: Implement the server-side analytics store.**

In `src/usage-analytics-server.js`, export `trackUsageEvent(redis, { event, sessionId, now })` and `readUsageSummary(redis, { days, now })`. Accept only `pdf_imported`, `phone_connected`, `phone_navigation`, and `session_ended`; require a UUID generated by `crypto.randomUUID()`. Use Redis keys under `gd:usage:v1:` so analytics never overlaps relay keys. Use one Lua `EVAL` to deduplicate session flags and update that day’s hash atomically.

Use these fields and limits:

```text
pdf_imports
phone_connected_sessions
pdf_and_phone_sessions
phone_navigation_sessions
completed_presentations
presentation_seconds
```

Store per-session flags and the first phone-connect timestamp for at most 24 hours from the first event. Count the combined funnel when both `pdf_imported` and `phone_connected` have arrived. On the first `session_ended` after a phone connection, add `min(14_400, max(0, now - firstPhoneAt))` seconds and increment `completed_presentations`. Expire each UTC-day aggregate key after 90 days. `readUsageSummary` accepts only `days` equal to `7`, `30`, or `90` and returns `{ days, totals, daily }`, where each daily row has `date` and the six counter fields above. `totals` has the same six fields plus `averagePresentationSeconds`, calculated as total seconds divided by completed presentations or `0` when none completed. Ranges include the current UTC day.

- [ ] **Step 5: Run the focused storage test and check the patch.**

Run:

```sh
node --test tests/usage-analytics-server.test.js
git diff --check
```

Expected: the event contract and deduplication tests pass; `git diff --check` exits `0`. Confirm the fake Redis models the intended script ordering, while recording that it does not prove production Lua behavior.

- [ ] **Step 6: Commit the aggregate store.**

```sh
git add src/redis-client.js src/cloud-remote-redis-server.js src/usage-analytics-server.js tests/usage-analytics-server.test.js
git commit -m "feat: add usage analytics aggregates"
```

### Task 2: Add the password-protected Vercel API

**Files:**
- Modify: `src/usage-analytics-server.js`
- Create: `api/usage-analytics.js`
- Modify: `vercel.json`
- Test: `tests/usage-analytics-server.test.js`

- [ ] **Step 1: Add failing request and authentication tests.**

Use the repository’s HTTP test style to call the function routes directly and assert that their public paths map to them in `vercel.json`:

- `POST /api/usage-analytics?__gd_route=event` accepts the four exact event payloads, rejects invalid JSON or fields with `400`, rejects a mismatched `Origin` with `403`, and returns `503` when Redis is unavailable.
- `POST /api/usage-analytics?__gd_route=login` rejects a wrong password, accepts `ANALYTICS_PASSWORD`, and sets a cookie with `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/api/usage-analytics`, and a 12-hour lifetime.
- `GET /api/usage-analytics?__gd_route=summary&days=7` returns `401` without a valid Redis-backed login token, returns the 7-day summary with one, and rejects unsupported ranges with `400`.
- `POST /api/usage-analytics?__gd_route=logout` deletes the login token and expires the cookie.
- Missing `ANALYTICS_PASSWORD` or missing Redis configuration does not expose summary data.

- [ ] **Step 2: Run the new request tests and confirm they fail for missing routes.**

Run:

```sh
node --test tests/usage-analytics-server.test.js
```

Expected: FAIL because route dispatch, login, and summary endpoints are not implemented yet.

- [ ] **Step 3: Implement route parsing, body checks, and owner sessions.**

Implement `attachUsageAnalytics(server, { redis, env, now })`. Parse only `event`, `login`, `logout`, and `summary` route names. Require same-origin `Origin` and JSON content type on POSTs, cap request bodies at 1 KiB, and return fixed JSON error codes. Compare the configured password with `timingSafeEqual`; on success, create a random token, store only its SHA-256 hash in Redis with a 12-hour expiry, and set the cookie flags in Step 1. Require the Redis-backed token for summary reads and logout. Never return the password, token, or Redis error details in response bodies.

- [ ] **Step 4: Add the Vercel function adapter and explicit rewrites.**

Create `api/usage-analytics.js` following the existing route adapter pattern:

```js
import { createServer } from 'node:http';
import { attachUsageAnalytics } from '../src/usage-analytics-server.js';

const server = createServer();
attachUsageAnalytics(server);

export default server;
```

In `vercel.json`, map each route to the function with an explicit rewrite, following the existing cloud-remote convention:

```json
{ "source": "/api/usage-analytics/event", "destination": "/api/usage-analytics?__gd_route=event" }
```

Add equivalent rewrites for `login`, `logout`, and `summary`. Ensure the server reads `__gd_route`, never trusts a route name from the JSON body, and collects events only when `VERCEL_ENV` is `production`.

- [ ] **Step 5: Run API tests and review access boundaries.**

Run:

```sh
node --test tests/usage-analytics-server.test.js
git diff --check
```

Expected: all route, origin, authentication, cookie, and storage-unavailable cases pass. Verify that event writes are public but strictly validated, while summary reads require the owner cookie.

- [ ] **Step 6: Commit the protected API.**

```sh
git add src/usage-analytics-server.js api/usage-analytics.js vercel.json tests/usage-analytics-server.test.js
git commit -m "feat: protect usage analytics summaries"
```

### Task 3: Track the approved browser events without affecting presenting

**Files:**
- Create: `src/usage-analytics-client.js`
- Modify: `app.js`
- Test: `tests/usage-analytics-client.test.js`
- Test: `tests/app.test.js`

- [ ] **Step 1: Add client tests for bounded session IDs and payloads.**

Assert that `getUsageSessionId(storage, crypto, now)` creates a UUID, reuses it in the same tab for less than 24 hours, and rotates it after 24 hours. Assert that `trackUsageEvent` sends only `{ event, sessionId }`, ignores event names outside the allowlist, and resolves without throwing when `fetch` or `navigator.sendBeacon` fails.

- [ ] **Step 2: Run the new client tests and confirm they fail for missing exports.**

Run:

```sh
node --test tests/usage-analytics-client.test.js
```

Expected: FAIL because the client module does not exist yet.

- [ ] **Step 3: Implement the small browser telemetry module.**

In `src/usage-analytics-client.js`, export `getUsageSessionId()` and `trackUsageEvent(event, { keepalive = false } = {})`. Store only the random UUID and its creation time in `sessionStorage`. Post the allowlisted event to `/api/usage-analytics/event` with same-origin credentials; use `navigator.sendBeacon` or `fetch(..., { keepalive: true })` for `session_ended`. Catch transport failures and never include filenames, file size, PDF bytes, slide state, phone labels, or identifiers other than the temporary UUID.

- [ ] **Step 4: Add event hooks at successful state transitions.**

In `app.js`:

- Call `trackUsageEvent('pdf_imported')` only after `loadPdfFile` successfully renders and installs the first PDF page.
- Call `trackUsageEvent('phone_connected')` from the `phonePaired` branch of `handleMobileRemoteConnection`.
- Wrap `handleRemoteCommand` in the callback passed by `connectMobileRemote`; call `trackUsageEvent('phone_navigation')` only when the command returns `true`.
- Call `trackUsageEvent('session_ended', { keepalive: pageIsHiding })` when a session with a paired phone ends, before clearing its local session state. Do not emit a duration event for failed starts or sessions with no phone.

Use a best-effort wrapper so an exception or rejected telemetry request cannot change the result of PDF loading, phone pairing, or command handling.

- [ ] **Step 5: Run focused client and app tests.**

Run:

```sh
node --test tests/usage-analytics-client.test.js tests/app.test.js
git diff --check
```

Expected: events fire only after successful actions; failed PDFs, rejected commands, local UI reset, and telemetry transport failures do not block the app.

- [ ] **Step 6: Commit the browser event hooks.**

```sh
git add src/usage-analytics-client.js app.js tests/usage-analytics-client.test.js tests/app.test.js
git commit -m "feat: track presentation usage events"
```

### Task 4: Build the private analytics page and keep it inside the static allowlists

**Files:**
- Create: `analytics.html`
- Create: `analytics.css`
- Create: `analytics.js`
- Modify: `server.mjs`
- Modify: `vercel.json`
- Modify: `scripts/build-vercel.mjs`
- Modify: `package.json`
- Test: `tests/server.test.js`

- [ ] **Step 1: Add static-route tests before allowing the new page.**

Extend `tests/server.test.js` to verify `GET /analytics` serves the analytics page, `GET /analytics.css` and `GET /analytics.js` serve their allowed assets, and a neighboring non-allowlisted path still returns `404`.

- [ ] **Step 2: Run the new server tests and confirm they fail for missing analytics assets.**

Run:

```sh
node --test tests/server.test.js
```

Expected: FAIL because `/analytics` and its assets are not in the static allowlist yet.

- [ ] **Step 3: Create the accessible page shell and login flow.**

Add `analytics.html` with this form and dashboard structure, along with links to `/styles.css` and `/analytics.css` and a module script for `/analytics.js`:

```html
<link rel="stylesheet" href="/styles.css">
<link rel="stylesheet" href="/analytics.css">
<form id="analytics-login">
  <label for="analytics-password">Owner password</label>
  <input id="analytics-password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Sign in</button>
  <p id="analytics-status" role="status" aria-live="polite"></p>
</form>
<section id="analytics-dashboard" hidden aria-labelledby="analytics-title">
  <h1 id="analytics-title">Usage analytics</h1>
  <label for="analytics-days">Time range</label>
  <select id="analytics-days"><option>7</option><option>30</option><option>90</option></select>
  <dl id="analytics-totals"></dl>
  <ol id="analytics-daily"></ol>
  <button id="analytics-logout" type="button">Sign out</button>
</section>
<script type="module" src="/analytics.js"></script>
```

Use `analytics.css` for the existing neutral palette and responsive layout. In `analytics.js`, POST the password to `/api/usage-analytics/login`, show the dashboard only after success, fetch `/api/usage-analytics/summary?days=<selected>`, and POST logout when the owner signs out. Render returned values with `textContent` and `createElement`; do not use `innerHTML` for server data. On page load, request a summary to reuse an existing valid same-site cookie; if it returns `401`, show the login form.

- [ ] **Step 4: Add static routes and copy the files in both serving paths.**

Map `/analytics` to `analytics.html` in `server.mjs` and add the page, CSS, and JS to its existing explicit root-file allowlist. Add the same `/analytics` rewrite in `vercel.json`. Add those files and `src/usage-analytics-client.js` to `scripts/build-vercel.mjs`’s explicit copies. Add `node --check` entries for `analytics.js`, `src/usage-analytics-server.js`, `src/usage-analytics-client.js`, and `api/usage-analytics.js` to `package.json`’s `check` command. Add `src/site-analytics.js` in Task 5 when that file is created.

- [ ] **Step 5: Run static server tests and inspect the built file set.**

Run:

```sh
node --test tests/server.test.js
npm run build:vercel
```

Expected: allowed paths return `200`, neighboring private files remain `404`, and `dist/` contains the analytics page and browser modules without `src/usage-analytics-server.js` or `api/usage-analytics.js`.

- [ ] **Step 6: Commit the dashboard and static routing.**

```sh
git add analytics.html analytics.css analytics.js server.mjs vercel.json scripts/build-vercel.mjs package.json tests/server.test.js
git commit -m "feat: add private usage analytics page"
```

### Task 5: Enable Vercel traffic analytics and disclose collection

**Files:**
- Create: `src/site-analytics.js`
- Modify: `index.html`
- Modify: `workspace.html`
- Modify: `scripts/build-vercel.mjs`
- Modify: `server.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Test: `tests/server.test.js`

- [ ] **Step 1: Add Vercel’s browser package and serve its browser entry locally.**

Add `@vercel/analytics` version `2.0.1` as a production dependency with `npm install --save-exact @vercel/analytics@2.0.1`. Create `src/site-analytics.js` using the package’s vanilla `inject()` API, as documented for plain JavaScript applications ([Vercel quickstart](https://vercel.com/docs/analytics/quickstart)):

```js
import { inject } from '../node_modules/@vercel/analytics/dist/index.mjs';

inject();
```

Keep the package script and request endpoints same-origin. Add only the package’s browser entry to `scripts/build-vercel.mjs`, add `node_modules/@vercel/analytics/dist/` to `server.mjs`’s existing public directory allowlist, and add `node --check src/site-analytics.js` to `package.json`’s `check` command. Do not add inline script or broaden `script-src` in the Content Security Policy.

- [ ] **Step 2: Add a static integration test for tracking page selection.**

Extend `tests/server.test.js` to assert `index.html` and `workspace.html` load `/src/site-analytics.js`, while `analytics.html` and `mobile-remote.html` do not.

- [ ] **Step 3: Run the new tracking integration test and confirm it fails.**

Run:

```sh
node --test tests/server.test.js
```

Expected: FAIL because the public pages do not load the Vercel integration yet.

- [ ] **Step 4: Load traffic tracking only on public landing/workspace pages.**

Add `<script type="module" src="/src/site-analytics.js"></script>` to `index.html` and `workspace.html`. Do not add it to `analytics.html` or `mobile-remote.html`, so owner dashboard and phone-only visits do not inflate public-site page views. Vercel Web Analytics must be enabled in the Vercel project dashboard; its script route is available after deployment.

- [ ] **Step 5: Update public copy and setup documentation.**

Update `index.html` and the README privacy section to say that anonymous public-site visits and aggregate feature-use counts are collected. Keep the precise claim that PDF bytes, filenames, and slide contents remain in the browser. Document `ANALYTICS_PASSWORD`, the existing Upstash Redis variables, the 90-day aggregate and 24-hour session retention, the `/analytics` page, and that local/self-hosted usage is not counted.

- [ ] **Step 6: Run syntax, lint, and static build checks for the new files.**

Run:

```sh
npm run check
npm run lint
npm run build:vercel
git diff --check
```

Expected: commands exit `0`; `dist/` includes `src/site-analytics.js` and `node_modules/@vercel/analytics/dist/index.mjs`; the CSP still disallows inline scripts and external script hosts.

- [ ] **Step 7: Commit Vercel traffic tracking and privacy documentation.**

```sh
git add src/site-analytics.js index.html workspace.html scripts/build-vercel.mjs server.mjs package.json package-lock.json README.md tests/server.test.js
git commit -m "feat: add Vercel visitor analytics"
```

### Task 6: Run complete project checks and record deployment prerequisites

**Files:**
- Verify: `src/usage-analytics-server.js`
- Verify: `src/usage-analytics-client.js`
- Verify: `api/usage-analytics.js`
- Verify: `analytics.html`, `analytics.js`, `analytics.css`
- Verify: `vercel.json`, `README.md`

- [ ] Run `node --test tests/usage-analytics-server.test.js tests/usage-analytics-client.test.js tests/app.test.js tests/server.test.js` and confirm all focused analytics and static-route tests pass.
- [ ] Run `npm run check`, `npm run lint`, and `npm test` as required for a cross-module protocol/data change. Expected: all commands exit `0`.
- [ ] Inspect the final diff for secret exposure, event payload fields, cookie flags, TTLs, key prefixes, public asset allowlists, Vercel rewrites, and unchanged phone relay payloads.
- [ ] Confirm the Redis fake models atomic event and expiry behavior but does not execute the production Lua scripts; do not claim that unit tests prove a deployed Upstash path.
- [ ] Record the Vercel setup steps: enable Web Analytics in the Vercel project; set `ANALYTICS_PASSWORD` in the production environment; confirm the existing Upstash Redis URL/token variables are configured; redeploy so Vercel’s analytics script route is available. Do not place any secret in source control or chat.
- [ ] Commit the implementation after the project checks pass. Do not deploy production as part of this plan; production deployment and verification remain separate workflow stages.

## Plan self-review

- **Spec coverage:** Vercel traffic dashboards are covered in Task 5; successful PDF, phone connection, combined funnel, navigation use, and duration are covered in Tasks 1 and 3; Redis aggregation and 90/24-day retention are covered in Task 1; password access and unavailable-storage behavior are covered in Task 2; the dashboard and allowlists are covered in Task 4; privacy/setup docs and project checks are covered in Tasks 5 and 6.
- **Placeholder scan:** No TBD/TODO or open-ended implementation steps remain. Event names, payload fields, route names, cookie flags, Redis key prefix, counters, retention, and commands are defined above.
- **Consistency:** The browser sends the same four event names accepted by the server. The client session UUID matches server validation. The `session_ended` event uses the first server-observed phone timestamp and caps duration at the hosted relay’s four-hour maximum.
- **Security boundary:** Static analytics assets may be public, but summary data and auth tokens remain server-side. Event requests carry only the event name and short-lived session UUID. The feature collector is production-only and best-effort.
- **Validation boundary:** Tests use a fake Redis model and cannot validate the live Vercel function, Vercel Analytics dashboard, or real Upstash Lua execution. Enable and inspect those integrations after deployment in the separate deployment/verification stage.
