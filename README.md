# GestureDeck

GestureDeck is a local-first presentation workspace. Present the built-in sample deck or a PDF with keyboard controls or a phone remote. A Chrome extension can connect a phone to a selected live Canva presentation.

## Quick start

Use Node.js 20, which is the version used by CI, and npm.

```sh
npm ci
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173) to use the sample deck. Choose **Open a PDF** to present an unprotected PDF from this device. Use the Previous and Next buttons or the left and right arrow keys; for a PDF, choose **Present fullscreen** after importing it.

## Phone-control options

| Option | Presenter and phone requirements | Controls |
| --- | --- | --- |
| Local remote | Same trusted Wi-Fi, iPhone Personal Hotspot, or Tailscale; the phone must be able to reach the laptop | Sample deck, PDF, or a connected Canva tab (with extension) |
| Canva remote | Chrome extension, Canva Present/View tab, and either the local or hosted GestureDeck workspace | Previous/Next in the selected Canva tab |
| Hosted remote | HTTPS GestureDeck deployment with Redis configured; devices may use different networks | Sample deck, PDF, or Canva on a supported workspace origin |

Each presentation processes one phone command at a time. A tap received while another command awaits acknowledgment is rejected; retry after the current command completes.

### Use the local phone remote

1. Turn on Personal Hotspot on the iPhone and connect the Mac or Windows laptop to it. Start GestureDeck on the laptop at `http://localhost:5173` or `http://127.0.0.1:5173`, then choose **Connect phone**.
2. Select the laptop network interface used by the hotspot and start pairing.
3. Scan the QR code with the iPhone or open its fallback URL. This works only if the iPhone can reach the laptop over the hotspot; some hotspot setups may block that connection. Use the hosted remote if the link does not open.
4. Up to eight phones can join. The invite lasts five minutes; renewing it keeps already paired phones connected.
5. Use **Previous** and **Next** on a phone. The numbered picker is available for the sample deck and PDFs. Canva exposes Previous/Next only.

The presenter can remove one phone or disconnect everyone. Each phone can disconnect itself and reconnect after a brief Wi-Fi drop. The temporary phone listener closes when the presenter ends the connection. Phones receive control state, not slide content, PDF files, or filenames. Local HTTP and WebSocket traffic is unencrypted outside a tunnel such as Tailscale, so pair only on a trusted network.

### Use a phone with live Canva

1. In Chrome, open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select this repository's `extension/` folder. Accept Chrome's debugger permission warning, then reload the extension after updating it.
2. Open the Canva design's `/view` or `/present` tab, and keep the Chrome toolbar visible. Before entering full-screen, open the GestureDeck extension and choose **Connect this presentation**.
3. Choose **Show phone QR/link** in the extension popup. The extension opens the hosted workspace at `https://gesturedeck-two.vercel.app/workspace.html?experience=cloud&connect=phone`; scan its QR code or copy the link to pair your phone.
4. After pairing, return to the same Canva tab and choose **Present**. Keep the hosted workspace open during the session.

For local pairing, connect the Canva tab with the extension while the Chrome toolbar is available, then follow [Use the local phone remote](#use-the-local-phone-remote) to pair your phone. After pairing, return to that same Canva tab and choose **Present**.

The phone's **Previous** and **Next** controls remain unavailable until Canva exposes accessible navigation controls, then become available. Readiness comes from Canva controls labeled “Previous page” or “Next page”; controls can be native buttons or elements with `role="button"`. Canva does not expose slide position or count, so phones show readiness and Previous/Next only. The phone's “Navigation sent to Canva” status confirms Chrome completed the key dispatch while the selected tab remained current; it does not confirm that Canva's slide changed. If Canva changes those labels or markup, navigation may stop working. Check Previous and Next in a signed-in presentation after updating the unpacked extension. Chrome warns that the extension requests its `debugger` permission, and displays Chrome's native debugging banner when the extension attaches to send navigation input. It supports `localhost:5173`, `127.0.0.1:5173`, and the production host above; a self-hosted domain must be added to the extension's origin allowlists. Canva editing mode is refused.

### Use the hosted phone remote

Open the hosted GestureDeck site over HTTPS, choose **Connect phone**, and pair phones with the QR code or link. The presenter can use a sample deck or import a PDF in that browser; for Canva, connect the selected tab with the extension first. Up to eight phones can join, including phones on another network.

The Vercel deployment uses Upstash Redis for temporary session and relay state. Configure `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in the deployment environment; the legacy `KV_REST_API_URL` and `KV_REST_API_TOKEN` names are also supported. Without these values, hosted pairing reports that storage is unavailable; local presentation still works. Never put Redis credentials in source control or browser code.

## Privacy and data flow

- Imported PDF bytes and rendered pages remain in the browser for the current page session.
- The local phone remote sends pairing credentials, phone labels, target readiness, slide position and busy state when available, and navigation commands. It does not send presentation media.
- Hosted sessions use Redis for temporary pairing credentials, phone metadata, target readiness, slide position, busy state, and navigation commands. Sessions expire after up to four hours and invites after five minutes. The relay does not receive PDFs, slide content, rendered pages, notes, or Canva credentials.

Use the hosted relay when phones cannot reach the presenter over the same LAN, iPhone hotspot, or Tailscale network. The sample deck works offline; PDF.js assets are served from the local project.

## Development

```sh
npm ci
npm test
npm run check
npm run lint
```

The project uses Node.js's built-in test runner. GitHub Actions runs the test, syntax-check, and lint commands on Node.js 20. To prepare the Vercel static assets locally, run `npm run build:vercel`; it writes the deployable files to `dist/site/`.

The development server defaults to `HOST=0.0.0.0` and `PORT=5173`. `HOST` also accepts `127.0.0.1`; set `PORT` to use another port. The local Canva extension bridge recognizes port `5173`.

## macOS app (Apple Silicon)

Build the self-contained app on an Apple Silicon Mac with Xcode Command Line Tools and Node.js/npm available:

```sh
npm ci
npm run build:macos
open dist/macos/GestureDeck.app
```

The app bundles its Node runtime, so running it does not require Terminal or a separate Node installation. It supports the sample deck, local PDF presentation, and local phone remote. Canva control remains in Chrome with the extension. Phone pairing requires a trusted network the phone can reach; local phone traffic is unencrypted unless tunneled through a service such as Tailscale. The initial build is unsigned and does not include a DMG, notarization, or Intel Mac support.

## Windows app (x64)

The portable x64 `.exe` opens its own window and does not require Node.js to run. Download `GestureDeck-Windows-x64` from a successful Windows portable app run in GitHub Actions, or build it on Windows with Node.js 22:

```sh
npm ci
npm run build:windows
```

The app is written to `dist/windows/`. It uses port `5173` and shows an error if that port is already occupied. In Windows Firewall, allow GestureDeck only on **Private networks**. If an iPhone hotspot is classified as Public, mark it Private only if you trust it; otherwise use trusted Wi-Fi or Tailscale. Do not enable the Public profile. On a reachable trusted network, scan the app's QR link with your phone to control the sample deck or a PDF. Canva control still requires Chrome and the extension. Windows may warn on first run because the app is unsigned. Real iPhone hotspot pairing has not been verified.

## Project layout

- `app.js`, `index.html`, and `workspace.html`: browser UI and page orchestration.
- `src/`: PDF, local remote, and hosted remote modules.
- `server.mjs`: local development server and local phone pairing routes.
- `api/` and `vercel.json`: Vercel cloud-relay routes and deployment configuration.
- `extension/`: Chrome Manifest V3 extension for live Canva control.
- `tests/`: Node.js tests for modules, server routes, and extension behavior.

## Technology and limits

GestureDeck uses HTML, CSS, vanilla JavaScript ES modules, Node.js, and PDF.js `4.10.38`.

GestureDeck controls its sample deck and imported PDFs in the browser. The Chrome extension adds phone-based Previous/Next control for a selected Canva presentation. It does not control Keynote, PowerPoint, or other presentation apps. Password-protected PDFs are not supported.

## Project links and team

- [Public GitHub repository](https://github.com/wehyn/GestureDeck)
- [Demo video](https://youtu.be/KlBZ4BAcMwo?si=nWaqGRmpesDprLg5)
- [LinkedIn video post](https://lnkd.in/p/gQFs2FYi)

**Team Cantos Family:** Vienn Yzabel C. Babasa, Harley Albert C. Buendia, Giann Ed Louise C. Garcia, and Wayne Andrei C. Garcia.

OpenAI Codex through Hermes Agent was used for AI-assisted planning, implementation, and documentation.
