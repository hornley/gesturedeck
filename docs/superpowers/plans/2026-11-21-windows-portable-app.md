# Windows Portable App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development for the implementation task, with spec and quality reviews before closeout.

**Goal:** Build a portable Windows x64 `.exe` that launches GestureDeck in an app window and keeps the existing phone remote available.

**Architecture:** Electron starts the existing Node server on `0.0.0.0:5173`, then loads the workspace from `127.0.0.1:5173`. The desktop process closes the mobile and cloud listeners on quit. Use an unpacked app directory so `server.mjs`'s realpath checks continue to inspect normal files. electron-builder creates the portable executable on a Windows CI runner and uploads it as an artifact.

**Tech Stack:** Electron, electron-builder, Node.js 20 project checks, Node.js 22 Windows packaging, GitHub Actions, `node:test`.

---

## Files and responsibilities

- `desktop/server-lifecycle.mjs`: starts the existing server and closes its attached remote services and HTTP listener.
- `desktop/main.mjs`: creates the secure Electron window, reports port/startup failures, and shuts down the server when the app exits.
- `tests/desktop-server-lifecycle.test.js`: covers server startup, workspace serving, port conflicts, and cleanup.
- `package.json` and `package-lock.json`: Electron entry point, build script, builder config, and pinned build dependencies.
- `.github/workflows/windows-app.yml`: builds and uploads the x64 portable executable from Windows.
- `README.md`: Windows build/run instructions, firewall prompt, and Canva extension limits.

## Task 1: Add desktop server lifecycle and app window

**Files:** Create `desktop/server-lifecycle.mjs`, `desktop/main.mjs`, and `tests/desktop-server-lifecycle.test.js`.

- [ ] **Step 1: Add lifecycle tests**

Write a test that starts the real app server on `127.0.0.1` with port `0`, requests `/workspace.html`, then closes it and confirms `server.listening` is false. Write a second case that reserves a local port, checks `startDesktopServer({ host: '127.0.0.1', port })` rejects with `EADDRINUSE`, then releases the reserved port.

```js
import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { startDesktopServer, stopDesktopServer } from '../desktop/server-lifecycle.mjs';

test('starts the workspace and closes its listeners', async (t) => {
  const server = await startDesktopServer({ host: '127.0.0.1', port: 0 });
  t.after(async () => { if (server.listening) await stopDesktopServer(server); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/workspace.html`);
  assert.equal(response.status, 200);
  await response.text();
  await stopDesktopServer(server);
  assert.equal(server.listening, false);
});

test('closes startup resources and reports an occupied port', async (t) => {
  const occupied = net.createServer();
  await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  await assert.rejects(
    startDesktopServer({ host: '127.0.0.1', port: occupied.address().port }),
    { code: 'EADDRINUSE' },
  );
});
```

Run: `node --test tests/desktop-server-lifecycle.test.js`
Expected: FAIL because the lifecycle module does not exist.

- [ ] **Step 2: Implement server lifecycle**

Export `startDesktopServer({ host = '0.0.0.0', port = 5173 } = {})` and `stopDesktopServer(server)` from `desktop/server-lifecycle.mjs`. Create the server with `createAppServer({ host })`; resolve startup on `listening`; reject its `error`; and close both `server.mobileRemote` and `server.cloudRemote` if startup fails. On stop, close those two remotes first, then close the HTTP server if it is listening.

```js
import { createAppServer } from '../server.mjs';

export async function startDesktopServer({ host = '0.0.0.0', port = 5173 } = {}) {
  const server = createAppServer({ host });
  try {
    await new Promise((resolve, reject) => {
      const listening = () => { server.off('error', failed); resolve(); };
      const failed = (error) => { server.off('listening', listening); reject(error); };
      server.once('listening', listening);
      server.once('error', failed);
      server.listen(port, host);
    });
    return server;
  } catch (error) {
    await stopDesktopServer(server);
    throw error;
  }
}

export async function stopDesktopServer(server) {
  try {
    await Promise.all([server.mobileRemote.close(), server.cloudRemote.close()]);
  } finally {
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
}
```

- [ ] **Step 3: Run lifecycle tests**

Run: `node --test tests/desktop-server-lifecycle.test.js`
Expected: both startup/cleanup and occupied-port cases pass.

- [ ] **Step 4: Add Electron main process**

In `desktop/main.mjs`, wait for `app.whenReady()`, start the server on port `5173`, and load `http://127.0.0.1:5173/workspace.html` into a `BrowserWindow`. Set `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`. Show a clear error when port 5173 is busy or startup fails. On `before-quit`, prevent exit until `stopDesktopServer()` finishes, then quit again. Quit when the last window closes.

```js
import { app, BrowserWindow, dialog } from 'electron';
import { startDesktopServer, stopDesktopServer } from './server-lifecycle.mjs';

let server;
let stopping = false;
const PORT = 5173;
const APP_ORIGIN = `http://127.0.0.1:${PORT}`;

app.whenReady().then(async () => {
  try {
    server = await startDesktopServer({ port: PORT });
    const window = new BrowserWindow({
      width: 1120,
      height: 760,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      try {
        if (new URL(url).origin === APP_ORIGIN) return;
      } catch {}
      event.preventDefault();
    });
    await window.loadURL(`${APP_ORIGIN}/workspace.html`);
  } catch (error) {
    const message = error.code === 'EADDRINUSE'
      ? 'Port 5173 is already in use. Close the other app using GestureDeck, then try again.'
      : error.message;
    dialog.showErrorBox('GestureDeck could not start', message);
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (!server || stopping) return;
  event.preventDefault();
  stopping = true;
  void stopDesktopServer(server).catch(console.error).finally(() => {
    server = undefined;
    app.quit();
  });
});
```

- [ ] **Step 5: Check JavaScript syntax**

Run: `node --check desktop/main.mjs && node --check desktop/server-lifecycle.mjs`
Expected: both files parse without errors.

## Task 2: Package the portable Windows executable and CI artifact

**Files:** Modify `package.json` and `package-lock.json`; create `.github/workflows/windows-app.yml`.

- [ ] **Step 1: Add Electron packaging configuration**

Set the package main entry to `desktop/main.mjs`. Add `electron` and `electron-builder` as development dependencies and add the script `"build:windows": "electron-builder --win portable --x64 --publish never"`. Append syntax checks for both new desktop modules to the `check` script. Configure product name `GestureDeck`, output `dist/windows`, `asar: false`, an explicit file allowlist for the desktop entry, server, browser root files, `src/`, and `extension/shared/`, and the Windows portable x64 target with a versioned `GestureDeck` `.exe` artifact name. Keep runtime dependencies available to electron-builder through `package.json`.

Use this build configuration in `package.json`:

```json
{
  "main": "desktop/main.mjs",
  "scripts": { "build:windows": "electron-builder --win portable --x64 --publish never" },
  "build": {
    "appId": "com.gesturedeck.desktop",
    "productName": "GestureDeck",
    "asar": false,
    "directories": { "output": "dist/windows" },
    "files": [
      "desktop/**", "server.mjs", "index.html", "workspace.html",
      "mobile-remote.html", "app.js", "styles.css", "home.css",
      "mobile-remote.css", "favicon.svg", "src/**", "extension/shared/**",
      "node_modules/pdfjs-dist/**"
    ],
    "win": {
      "target": [{ "target": "portable", "arch": ["x64"] }],
      "artifactName": "GestureDeck-${version}-portable-${arch}.${ext}"
    }
  }
}
```

Run: `npm install --save-dev electron electron-builder`
Expected: package metadata and lockfile contain the two development dependencies.

- [ ] **Step 2: Add the Windows build workflow**

Create `.github/workflows/windows-app.yml` with `pull_request` targeting `main` and `workflow_dispatch` triggers. On `windows-latest`, check out the code, install Node.js 22 (Electron 45 requires 22.12 or newer to build), run `npm ci`, run `npm run build:windows`, launch the packaged `.exe`, confirm it serves `/workspace.html`, close it and confirm port 5173 is released, then upload the versioned `.exe` using `actions/upload-artifact@v4`. Fail if launch, shutdown, or artifact upload fails. Leave the existing Node.js 20 test workflow unchanged.

```yaml
name: Windows portable app

on:
  pull_request:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build:windows
      - name: Smoke test portable app
        shell: pwsh
        run: |
          $artifact = Get-ChildItem "dist/windows/*.exe" | Select-Object -First 1
          if (!$artifact) { throw "The portable executable was not created." }
          $app = Start-Process -FilePath $artifact.FullName -PassThru
          try {
            $ready = $false
            for ($attempt = 0; $attempt -lt 30; $attempt++) {
              try {
                $response = Invoke-WebRequest -Uri "http://127.0.0.1:5173/workspace.html" -UseBasicParsing -TimeoutSec 2
                if ($response.StatusCode -eq 200) { $ready = $true; break }
              } catch { Start-Sleep -Seconds 1 }
            }
            if (!$ready) { throw "The portable app did not serve the workspace." }
            if ($app.HasExited) { throw "The portable app exited before shutdown was requested." }
          } finally {
            if (!$app.HasExited) {
              $app.CloseMainWindow() | Out-Null
              if (!$app.WaitForExit(10000)) { Stop-Process -Id $app.Id -Force; throw "The portable app did not close." }
            }
          }
          for ($attempt = 0; $attempt -lt 10; $attempt++) {
            if (!(Test-NetConnection 127.0.0.1 -Port 5173 -InformationLevel Quiet -WarningAction SilentlyContinue)) { break }
            Start-Sleep -Seconds 1
          }
          if (Test-NetConnection 127.0.0.1 -Port 5173 -InformationLevel Quiet -WarningAction SilentlyContinue) {
            throw "The portable app left port 5173 open after shutdown."
          }
      - uses: actions/upload-artifact@v4
        with:
          name: GestureDeck-Windows-x64
          path: dist/windows/*.exe
          if-no-files-found: error
```

- [ ] **Step 3: Verify build configuration locally**

Run: `npm run build:windows`
Expected on Windows: electron-builder creates one x64 portable `.exe` under `dist/windows`. On macOS, record the platform limitation instead of treating a missing Windows toolchain as a passing build.

## Task 3: Document use and run required checks

**Files:** Modify `README.md` and verify all changed files.

- [ ] **Step 1: Document Windows use**

Add a Windows x64 portable app section with the no-Node-install requirement, local build command, GitHub Actions artifact location, port 5173 behavior, and Windows Firewall private-network prompt. State that Canva still needs Chrome and the extension. Describe the hotspot path as intended but unverified on physical devices.

Include these user instructions:

```markdown
## Windows portable app (x64)

The portable `.exe` opens GestureDeck in its own window; you do not need to install Node.js. Download the `GestureDeck-Windows-x64` artifact from a successful **Windows portable app** Actions run, or build it on Windows with Node.js 22 and `npm ci` followed by `npm run build:windows`; the file is written to `dist/windows/`.

The app uses local port 5173. If another app is already using it, close that app before launching GestureDeck. When Windows Firewall asks, allow GestureDeck on a private network so a phone on the same Wi-Fi or hotspot can reach the remote. Physical iPhone hotspot pairing has not been verified. Canva control still needs Chrome and the GestureDeck extension.
```

- [ ] **Step 2: Run the focused test and project checks**

Run: `node --test tests/desktop-server-lifecycle.test.js`, `npm test`, `npm run check`, `npm run lint`, and `git diff --check`.
Expected: all commands pass.

- [ ] **Step 3: Confirm workflow artifact**

After the pull request starts the Windows job, confirm the job succeeds and its uploaded artifact contains the versioned portable x64 `.exe`. State clearly that CI packaging does not verify real iPhone hotspot reachability or firewall behavior.

## Plan self-review

- The app lifecycle, fixed port, error handling, secure window, portable target, Windows artifact, README, and focused test are covered.
- Existing phone payloads, route allowlists, host/origin/peer checks, and remote protocols are untouched.
- The Electron window denies external navigation and does not expose Node APIs to the page.
- The macOS app build remains on its existing script and target.
- The macOS host lacks Windows packaging tools; the Windows Actions artifact is the required executable build check.
