# GestureDeck Minimalist UI/UX Design

- **Design status:** Approved design brief; written spec pending user review
- **Baseline:** `hornley/main` at `0d3ca14`
- **Product context:** [`PRODUCT.md`](../../../PRODUCT.md)

## Context

GestureDeck has four user-facing surfaces: its landing page, presenter workspace, phone remote, and Canva extension popup. The landing page and workspace use a warm light palette, while the phone remote and extension popup use separate dark and green styles. Canva setup relies on short status messages, so users must infer which step is missing and whether phone controls are ready.

The approved direction is **Warm clarity**. The experience should stay visually quiet while making Canva setup and connection readiness explicit across the full journey.

## Goals

1. Use one restrained, warm visual language across all four surfaces.
2. Keep the active presentation, the next action, and connection state easy to identify.
3. Explain the Canva flow with a clear next step for each connection state.
4. Preserve existing presentation, PDF, phone pairing, Canva, and recovery behavior.
5. Keep the interface accessible on keyboard, screen readers, reduced-motion settings, and touch devices.

## Non-goals

- Change pairing protocols, Redis data, network or origin checks, session limits, expiry, or recovery behavior.
- Change which Canva pages are supported, which commands Canva receives, or when navigation is enabled.
- Add accounts, analytics, new presentation targets, external fonts, images, or UI dependencies.
- Change the local-first privacy boundary or send presentation content to the relay.

## Visual direction

- Use a **Restrained** color strategy: warm paper and neutral surfaces, readable charcoal text, a muted clay accent for primary actions, and a muted green for connected/success states.
- Use a light theme throughout. The physical scene is a presenter preparing in a bright room, then using a phone while standing and presenting; the interface should feel calm and dependable in both settings.
- Use a restrained serif for large editorial headings and sample-slide titles. Use a clear sans-serif for controls, form labels, status text, and instructional copy.
- Use spacing, alignment, and subtle dividers to group content. Reserve borders and filled surfaces for controls or content that truly needs separation. Avoid nested panels, decorative gradients, and ornamental motion.
- Reference cues: Keynote's presentation-first focus, Notion's quiet typography, and Linear's direct status language.

## Surface design

### Landing page

- Keep one clear path into the workspace and a concise explanation of local files and phone control.
- Keep the presentation preview as the main visual. Remove decorative elements that compete with the action or privacy message.
- Make the page usable on narrow screens without shrinking text or hiding the main action.

### Presenter workspace and pairing

- Keep the slide canvas visually primary, with deck source choices and navigation grouped nearby.
- Make Sample deck, Open a PDF, and Connect phone distinct actions with a clear selected source.
- Keep local and hosted pairing instructions specific to the selected mode. Keep QR code, fallback URL, copy action, paired-phone state, link renewal, and disconnect actions available in their current states.
- Keep recovery and capacity errors visible with a clear next step. Do not hide connection status behind decorative status pills alone.
- Retain the native pairing dialog, existing DOM hooks, fullscreen behavior, keyboard navigation, and PDF controls unless a reviewed implementation plan identifies a necessary markup change.

### Phone remote

- Use the same warm light palette and typography as the presenter workspace.
- Keep connection status and the assigned presentation visible above the controls.
- Keep Previous and Next large and thumb-friendly. Preserve slide-number navigation for decks and PDFs, and readiness gating for Canva.
- Keep reconnect, expired-link, rejected-pair, storage-error, and explicit-disconnect recovery copy visible and actionable.

### Canva extension popup

- Use the same brand colors, typography, focus treatment, and button hierarchy as the web app within the popup's narrow width.
- Present setup as clear progress: connect a supported Canva tab, start Present when navigation is not ready, then open the phone pairing page.
- Show the next required action for disconnected, connected-but-not-presenting, ready, Canva-unavailable, presentation-required, and pairing-page-open-failure states.
- Preserve current behavior: the phone-pairing action stays enabled when a Canva tab is connected, even if Canva is not yet ready; the status explains that starting Present enables navigation.
- Keep the existing element IDs used by `popup.js` and update the popup fixture tests if markup changes. Bump `extension/manifest.json` from `0.1.1` to `0.1.2` for the packaged popup changes.

## Interaction and accessibility

- Keep semantic buttons and labels, visible keyboard focus, screen-reader live statuses, and reduced-motion support.
- Use a consistent focus ring and action hierarchy across the workspace, remote, and popup.
- Keep touch controls at least 44px in their tap area.
- Ensure error, disabled, loading, connected, and ready states are identifiable by text and not color alone.
- Avoid adding UI behavior that requires a new server, extension protocol, or persisted state.

## Affected files

- Landing: `index.html`, `home.css`.
- Presenter workspace and pairing dialog: `workspace.html`, `styles.css`.
- Phone remote: `mobile-remote.html`, `mobile-remote.css`.
- Canva popup: `extension/popup/popup.html`, `extension/popup/popup.css`, `extension/popup/popup.js`, `extension/manifest.json`.
- Focused UI tests: `tests/app.test.js`, `tests/canva-extension.test.js`, and `tests/mobile-remote-phone.test.js` where existing assertions or fixtures depend on changed markup or copy.
- Product context: `PRODUCT.md`.

Do not change `scripts/build-vercel.mjs`, `server.mjs`, or extension origin/protocol files unless the implementation adds or removes a public asset or changes the extension protocol. The design requires neither.

## Acceptance criteria

1. Landing, workspace, phone remote, and extension popup share the approved Warm clarity system while preserving the presentation as the focus.
2. Users can identify how to connect Canva, whether the selected tab is ready, and the next action in each popup state.
3. The pairing action remains available for a connected but not-yet-presenting Canva tab.
4. Sample-deck, PDF, fullscreen, local and hosted pairing, reconnect, and Canva navigation behavior remain intact.
5. All important status and error messages remain perceivable without relying on color, and controls remain keyboard- and touch-accessible.
6. No presentation content, PDF data, Canva credentials, or additional state crosses existing privacy boundaries.
7. The Canva extension patch version is incremented once for the popup UI changes.

## Validation plan

- Run the focused workspace, extension popup, and phone remote tests.
- Run `npm run check`, `npm run lint`, and `npm test`.
- Check the landing page, workspace at desktop and narrow widths, phone remote at phone width, and extension popup states for visual consistency and readable statuses.
- Confirm no UI change altered network, Redis, extension-origin, or presentation payload behavior.

## Risks and limits

- The serif display face must stay limited to headings so instructional text and compact popup labels remain easy to scan.
- The popup's small size may constrain the Canva progress explanation; prioritize one immediate next action per state and keep secondary detail concise.
- Test fixtures cover DOM contracts, not physical-phone ergonomics, a signed-in Canva session, or deployed Redis behavior.
