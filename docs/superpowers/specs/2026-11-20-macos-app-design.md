# GestureDeck macOS app design

## Status

Approved by the user on 2026-11-20.

## Goal

Let the user double-click GestureDeck on their Apple Silicon Mac. The app starts the existing local server, opens the existing presentation workspace in its own window, and lets a phone on the Mac's trusted local network open the phone remote. The installed app must not depend on Terminal or a separately installed Node.js runtime.

## Chosen approach

Build a small native SwiftUI app that hosts the existing workspace in `WKWebView` and starts a bundled Node.js process for `server.mjs`.

This keeps the presentation, PDF, and phone-pairing behavior in the current HTML and JavaScript. An Electron shell would add a second Chromium runtime and a larger package. A native rewrite would duplicate the current server and presentation logic.

## User flow

1. The user opens `GestureDeck.app`.
2. The app starts its bundled ARM64 Node runtime with the packaged project files, using the existing server on port 5173 and its default `0.0.0.0` bind.
3. Once the server reports that it started, the app loads `http://127.0.0.1:5173/workspace.html` in a native window.
4. The user may choose the sample deck, import a PDF, or choose **Connect phone**. For hotspot pairing, the app uses the existing network-interface picker, QR link, and phone remote flow.
5. Closing the app stops the Node process. The existing server's SIGTERM handler closes phone and cloud remote sessions.

The phone continues to use Safari or another browser. Canva control remains in Chrome with the existing Chrome extension; it is not available inside the WebKit app window.

## Components and packaging

- A small SwiftUI/AppKit application owns the window and `WKWebView`.
- A bundled ARM64 Node executable runs `server.mjs`; the app build script copies the runtime used to build the app, so installed use requires no Node installation.
- The app bundle contains the existing server entry point, HTML/CSS/JavaScript, project modules, shared extension protocol files, and the PDF.js build assets currently served from `node_modules/pdfjs-dist`.
- Build output is `dist/macos/GestureDeck.app`. This first build targets the current Apple Silicon Mac. It does not create a DMG or installer.
- The app Info.plist allows local HTTP to loopback and explains local-network use. macOS may still show its local-network or firewall prompt when a phone connects.

## Network and data boundaries

The app uses the existing local server, phone listener, pairing session, and QR flow. It must preserve the server's explicit public-path allowlist, realpath checks, host/origin/peer checks, and the temporary phone listener's private/Tailscale IPv4 validation. It must not add a new phone relay or send PDFs or rendered slide content to the phone. PDF data stays in the app's WebKit page for the current session. Local phone traffic remains unencrypted unless the user uses a tunnel such as Tailscale.

## Errors and shutdown

The app waits for the child server's startup message before loading the workspace. If the child exits or port 5173 is unavailable, the app shows an actionable startup error and does not load an unrelated service that may already be using the port. The child process is terminated when the app quits; the existing server handles cleanup on SIGTERM.

## Verification

- Build the `.app` and check that its bundled Node executable, server entry point, web files, and PDF.js assets are present.
- Run the app and confirm the workspace opens without Terminal or an external Node installation.
- Use the existing local pairing flow to confirm the app-hosted server can produce a phone link; a physical iPhone hotspot check is separate from the simulator check already completed.
- Do not change the current browser test suite unless app integration requires a browser or server behavior change.

## Out of scope

- Windows packaging, Intel or universal builds, an iPhone app, app auto-updates, and automatic signing/notarization for public distribution.
- Rewriting the app UI or server in native code.
- Running Canva inside the Mac app; its current workflow remains in Chrome.
