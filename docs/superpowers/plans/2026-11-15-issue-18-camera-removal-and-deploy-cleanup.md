# Camera Removal and Deployment Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove camera capture and gesture controls from the current workspace, and keep their model/runtime out of local public assets and the Vercel deployment.

**Architecture:** Remove the active camera path from `app.js` and its workspace markup while retaining manual, PDF, phone, and Canva controls. Keep standalone camera-module tests as development-only if they remain useful, move MediaPipe to `devDependencies`, and stop copying the camera/model/runtime into deploy output.

**Tech Stack:** Node.js 20, vanilla JavaScript ES modules, PDF.js, Node's built-in test runner, and the existing explicit server/build allowlists.

---

**Dependency:** Run [hosted session recovery](2026-11-15-issue-18-hosted-session-recovery.md) first. Both plans touch `app.js` and `tests/app.test.js`; implement them serially on the shared issue branch.

## Files and responsibilities

- `app.js`: remove camera/gesture imports, state, setup and inference lifecycle, and gesture event handling; preserve slide, PDF, phone, Canva, and keyboard behavior.
- `workspace.html` and `styles.css`: remove camera UI, gesture guidance/settings, and styles used only by that UI.
- `index.html` and `README.md`: describe the camera-free local workspace and remove stale camera/gesture setup claims.
- `assets/hand_landmarker.task`: delete the unused model.
- `scripts/build-vercel.mjs`: stop copying camera modules, model, MediaPipe runtime, and WASM; retain required PDF.js, phone, and Canva assets.
- `package.json` and `package-lock.json`: make MediaPipe test-only while module tests still need its files, and update the stale package description.
- `server.mjs` and `tests/server.test.js`: remove and verify denial of the selected public MediaPipe path without weakening the path allowlist or realpath checks.
- `tests/app.test.js` and new `tests/build-vercel.test.js`: cover the camera-free workspace and exact deployment asset set.
- Leave the root `spec.md`, the phone server's separate asset allowlist, and camera module unit tests unchanged.

## Task 1: Replace app-level camera behavior tests

**Files:** `tests/app.test.js`

- [ ] **Step 1: Add a camera-free workspace assertion.** Assert the HTML has no setup/session buttons, camera selector/preview/diagnostics, gesture settings, or gesture guide. Keep a mocked `navigator.mediaDevices.getUserMedia` counter and assert it remains zero while loading the app and exercising sample/PDF/manual/phone paths.

```js
for (const id of [
  'start-setup', 'start-session', 'pause-session', 'resume-session', 'camera-preview',
  'camera-selection', 'camera-diagnostics', 'gesture-sensitivity', 'reverse-mapping',
]) {
  assert.equal(elements.has(id), false, `${id} is not part of the camera-free workspace`);
}
assert.equal(cameraRequests, 0);
```

- [ ] **Step 2: Remove app tests that require camera setup, capture, preview, or gesture settings.** Preserve tests for PDF rendering, slide boundaries, keyboard navigation, local/hosted phone pairing, and Canva readiness/navigation.
- [ ] **Step 3: Add one explicit keyboard navigation assertion.** Verify ArrowLeft and ArrowRight still change the current slide when no input, select, textarea, editable element, or button has focus.
- [ ] **Step 4: Run the app test and confirm the new assertions fail against the current camera-enabled markup.**

Run: `node --test tests/app.test.js`

Expected: camera elements are still found and camera-specific tests still pass; the new no-camera assertion fails.

## Task 2: Remove camera behavior and controls from the presenter workspace

**Files:** `app.js`, `workspace.html`, `styles.css`, `tests/app.test.js`

- [ ] **Step 1: Remove camera-only imports and element references from `app.js`.** Remove `CameraSession`, camera preview, hand overlay/tracking, local hand-landmarker, and `SwipeRecognizer` imports. Remove camera-only DOM references and settings state; keep `PresentationController`, PDF, mobile remote, and Canva imports.
- [ ] **Step 2: Remove camera lifecycle and gesture event wiring.** Delete setup, capture, pause/resume, frame processing, inference, preview, camera-selection persistence, and gesture-sensitivity/reverse-mapping logic. Keep `announceAction`, PDF rendering/fullscreen, phone pairing, keyboard handling, and Canva bridge behavior.
- [ ] **Step 3: Remove camera and gesture markup from `workspace.html`.** Delete setup/session controls, camera status and preview, camera picker, diagnostics, hand status, advanced gesture settings, and gesture guide. Keep deck selection, slide controls, PDF controls, the phone pairing dialog, and generic action feedback.
- [ ] **Step 4: Remove only styles used by deleted camera/gesture UI.** Keep shared buttons, status/toast styles, phone pairing layout, slide canvas, PDF stage, and responsive rules that still serve present controls.
- [ ] **Step 5: Update the workspace description and sample-deck copy.** Remove claims that the sample deck is controlled by swipes or camera gestures; keep presentation and phone-remote text accurate.
- [ ] **Step 6: Run the app tests.**

Run: `node --test tests/app.test.js`

Expected: the camera-free assertion and preserved keyboard/PDF/phone/Canva tests pass.

## Task 3: Align the landing page and README

**Files:** `index.html`, `README.md`, `package.json`

- [ ] **Step 1: Replace the landing navigation label `Local gesture version` with `Local browser workspace`.** Keep the existing `/workspace.html` destination.
- [ ] **Step 2: Remove README camera setup instructions and current-product claims about MediaPipe, local camera inference, saved gesture settings, and the hand-model asset.** Keep the local/hosted phone requirements, PDF privacy, Canva behavior, and the statement that the extension does not request camera access.
- [ ] **Step 3: Change the `package.json` description from webcam/gesture control to a local-first presentation workspace.** Keep MediaPipe in `devDependencies` until the camera-module test is retired.
- [ ] **Step 4: Search current product copy for stale camera claims.**

Run: `rg -ni 'camera|gesture|webcam|mediapipe|hand.landmarker' README.md index.html workspace.html app.js package.json`

Expected: remaining matches are only test/build tooling descriptions or copy that accurately says the app does not request camera access.

## Task 4: Remove camera assets from local and Vercel delivery

**Files:** `assets/hand_landmarker.task`, `scripts/build-vercel.mjs`, `server.mjs`, `package.json`, `package-lock.json`, `tests/server.test.js`, new `tests/build-vercel.test.js`

- [ ] **Step 1: Delete the unused model.** Run `git rm assets/hand_landmarker.task`.
- [ ] **Step 2: Remove model, camera/gesture module, and MediaPipe copies from `scripts/build-vercel.mjs`.** Keep `index.html`, workspace assets, extension bridge/protocol modules, `src/pdf-presentation.js`, `src/presentation.js`, phone client modules, and PDF.js files.
- [ ] **Step 3: Remove only `node_modules/@mediapipe/tasks-vision/` from the selected public directory list in `server.mjs`.** Preserve the `src/`, `assets/`, and PDF.js allowlist entries and both path/realpath checks.
- [ ] **Step 4: Move MediaPipe to development dependencies and update the lockfile.**

Run: `npm install --save-dev --save-exact @mediapipe/tasks-vision@0.10.33`

Expected: `package.json` lists MediaPipe under `devDependencies`, not `dependencies`; existing module tests can still read its bundle after `npm ci`.

- [ ] **Step 5: Extend `tests/server.test.js`.** Request `/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs` from the local server and assert it is denied (404). Keep existing allowlist traversal and PDF.js availability assertions.
- [ ] **Step 6: Add `tests/build-vercel.test.js`.** Run `scripts/build-vercel.mjs`, assert camera/model/MediaPipe paths are absent from `dist/`, and assert required PDF.js, workspace, phone, and extension bridge assets remain. Remove `dist/` in `t.after` so the test leaves no generated files.
- [ ] **Step 7: Run focused delivery tests.**

Run: `node --test tests/server.test.js tests/build-vercel.test.js`

Expected: MediaPipe is denied by the local server and the Vercel output omits camera assets while retaining PDF.js and remote assets.

## Task 5: Full validation and asset inspection

**Files:** none; verification only.

- [ ] Run `node --test tests/app.test.js tests/server.test.js tests/build-vercel.test.js`.
- [ ] Run `npm test`, `npm run check`, and `npm run lint`.
- [ ] Run `npm run build:vercel`, then verify the output directly:

```sh
test ! -e dist/assets/hand_landmarker.task
test ! -e dist/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs
test ! -e dist/node_modules/@mediapipe/tasks-vision/wasm
test ! -e dist/src/camera-session.js
test -e dist/src/pdf-presentation.js
test -e dist/src/mobile-remote-client.js
test -e dist/node_modules/pdfjs-dist/build/pdf.mjs
```

**Risk boundary:** camera gestures are intentionally removed. Existing camera-module tests may remain development-only; they do not imply that camera capture is part of the running workspace.
