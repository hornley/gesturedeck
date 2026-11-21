# Windows Portable App Design

## Goal

Build a portable Windows x64 `.exe` that opens GestureDeck as a desktop app and lets an iPhone on the same hotspot control the presentation.

## Design

Use Electron to wrap the existing web UI and Node server. On launch, the app starts the existing server on `0.0.0.0:5173`, opens the local workspace at `127.0.0.1:5173` in an app window, and closes the server when the app exits. Keep port 5173 so the existing Chrome extension origin continues to work. Package it as a portable `.exe` that runs without an installer or Start Menu entry.

Keep the current local phone pairing flow and its network checks. The phone continues to connect through the QR code and receives control state and navigation commands only. Do not add a native phone app or change the presentation and remote protocols.

Build the Windows x64 executable in a Windows GitHub Actions runner, since this development machine is macOS and has no Windows packaging tools. Publish the executable as a workflow artifact for download.

## Scope and limits

- Include the desktop wrapper, existing app files, and required Node dependencies in the portable executable.
- Keep the server's public path allowlist, realpath checks, host/origin validation, and phone peer checks.
- Show a useful error if port 5173 is occupied or the local server cannot start; close all listeners when the app exits.
- Canva control still requires Chrome and the existing GestureDeck extension.
- Windows may show a security warning because the personal build is unsigned. Hotspot reachability and Windows Firewall behavior require a real Windows laptop and iPhone check.

## Validation

Run the project's focused tests, `npm run check`, and `npm run lint`. Build the Windows x64 artifact on the CI runner and confirm the portable executable launches, serves the workspace, and shuts down its local server. Report physical hotspot pairing as unverified until tested on those devices.
