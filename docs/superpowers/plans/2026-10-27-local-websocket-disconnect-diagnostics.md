# Local and Hosted WebSocket Disconnect Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Log which local or hosted mobile-remote WebSocket closed, with its close code and reason when available.

**Architecture:** Keep diagnostics in the local server's presenter and phone close handlers, and in the Redis-backed hosted relay after its route identifies presenter or phone. Emit one JSON-formatted console line per accepted socket; do not change protocol messages, reconnect behavior, or session cleanup.

**Tech Stack:** Node.js, existing custom WebSocket server, `node:test`.

---

### Task 1: Log and verify local socket closes

**Files:**
- Modify: `src/mobile-remote-server.js`
- Test: `tests/mobile-remote-server.test.js`

- [x] **Step 1: Add a close-frame helper and failing test**

Create a masked client close frame for the server test fixture:

```js
function clientCloseFrame(code, reason = '') {
  const reasonBytes = Buffer.from(reason, 'utf8');
  const payload = Buffer.alloc(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  const mask = Buffer.from([1, 2, 3, 4]);
  for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  return Buffer.concat([Buffer.from([0x88, 0x80 | payload.length]), mask, payload]);
}
```

In a new `node:test` case, capture `console.info` with `t.mock.method`, start the local remote, authenticate its presenter, pair a phone, and close each socket with a masked close frame. Assert that parsed log entries identify `phone` and `presenter` with their sent codes and reasons; assert a phone close leaves the listener active and a presenter close ends it.

- [x] **Step 2: Run the focused test and confirm it fails**

Run: `node --test tests/mobile-remote-server.test.js`

Expected: the new close-diagnostic assertion fails because no close lines are logged.

- [x] **Step 3: Log close metadata in both local handlers**

Add this helper to `src/mobile-remote-server.js`:

```js
function logWebSocketClose(side, code, reason) {
  console.info(`[mobile-remote] ${side} WebSocket closed ${JSON.stringify({
    code: code ?? null,
    reason: reason ?? '',
  })}`);
}
```

Pass `(code, reason)` from each existing socket `close` listener to the helper. Keep existing cleanup in those listeners. JSON serialization escapes control characters in peer-provided reasons; log no credentials, phone metadata, addresses, or messages.

- [x] **Step 4: Re-run the focused test**

Run: `node --test tests/mobile-remote-server.test.js`

Expected: PASS, including assertions that phone closure leaves the session active and presenter closure still stops it.

- [x] **Step 5: Run repository JavaScript checks**

Run: `npm run check` and `npm run lint`.

Expected: both commands pass.

### Task 2: Log and verify hosted Vercel relay closes

**Files:**
- Modify: `src/cloud-remote-redis-server.js`
- Test: `tests/cloud-remote-redis-server.test.js`
- Update: `docs/superpowers/specs/2026-10-27-local-websocket-disconnect-diagnostics-design.md`

- [x] **Step 1: Add a failing hosted close test**

Capture `console.info` with `t.mock.method`, create the Redis relay fixture, authenticate a presenter, and pair a phone. Close each client WebSocket with a reason containing CR/LF. Assert the logs identify each role, include the close code and reason as JSON, contain no raw line breaks, and omit credentials and phone identity.

- [x] **Step 2: Run the focused test and confirm it fails**

Run: `node --test --test-name-pattern="hosted Redis WebSocket close logs" tests/cloud-remote-redis-server.test.js`

Expected: the missing phone close log assertion fails.

- [x] **Step 3: Log the resolved hosted role and close details**

Add a JSON-formatted close logger and register it where the relay already maps each connection to presenter or phone:

```js
function logWebSocketClose(side, code, reason) {
  console.info(`[cloud-remote] ${side} WebSocket closed ${JSON.stringify({
    code: code ?? null,
    reason: reason ?? '',
  })}`);
}

function onRemoteConnection(socket, request, route) {
  sockets.add(socket);
  const side = route === '/ws/cloud-remote/presenter' ? 'presenter' : 'phone';
  socket.once('close', (code, reason) => logWebSocketClose(side, code, reason));
  // Existing route handling continues here.
}
```

- [x] **Step 4: Run the local and hosted focused tests**

Run: `node --test tests/mobile-remote-server.test.js` and `node --test tests/cloud-remote-redis-server.test.js`.

Expected: both files pass and existing close behavior remains unchanged.

- [x] **Step 5: Run the full checks and Vercel build**

Run: `npm test`, `npm run check`, `npm run lint`, and `npm run build:vercel`.

Expected: all checks pass and the build writes `dist/` successfully.
