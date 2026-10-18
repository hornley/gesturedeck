# Canva DOM Control Navigation Design

**Date:** 2026-10-19
**Status:** Implemented; live Canva validation pending.

## Problem

Hosted phone commands reach the presenter, but Canva may not change slides. The extension content script dispatches synthetic `KeyboardEvent`s and reports success when dispatch does not throw. Canva can ignore those untrusted events, so the phone's positive acknowledgement currently overstates what was confirmed.

The earlier Chrome debugger input path was manually verified to advance Canva, but it requests the `debugger` permission and triggers Chrome's debugger warning. The selected direction is to try Canva's own presentation navigation controls without that permission.

## Goals

- Make phone Previous/Next activate the selected Canva tab's own presentation navigation controls in Present and View mode.
- Keep the extension free of the Chrome `debugger` permission and its warning.
- Report a positive acknowledgement as “Navigation sent to Canva,” without implying that slide movement was observed.
- Preserve tab selection and generation fencing, narrow Previous/Next-only Canva payloads, and the existing separation between presenter content and phone relay data.

## Design

Keep the existing phone, hosted relay, presenter, and extension message flow. In `extension/content/canva-content.js`, map the existing `ArrowLeft` and `ArrowRight` message keys to Canva controls with accessible names `Previous page` and `Next page`. Find native buttons or `[role="button"]` controls by normalized `aria-label`, require one unambiguous enabled match, and call its `.click()` method. A Present or View route is ready only when at least one of those navigation controls is present; a Canva viewing workspace with page thumbnails alone is not ready. Do not use Canva's private CSS class names, infer slide position, or send content to the phone or relay.

If the presentation route is no longer ready, a control is missing, disabled, ambiguous, or click activation throws, respond with `accepted: false`. A successful `.click()` call means only that the control was activated; it does not prove the rendered slide changed. Update the phone's positive Canva acknowledgement to say “Navigation sent to Canva.” Keep the existing generic acknowledgement for sample decks and PDFs.

The selector evidence is limited: [a public Canva View automation example](https://www.lprp.fr/2024/08/download-canva-view-only-shared-slideshow-as-pdf/) used `button[aria-label="Previous page"]` and `button[aria-label="Next page"]` with `.click()`, but warned that Canva may change its selectors. The user's Canva Viewing workspace showed page items as `div[role="button"]` and exposed no Previous/Next labels, prompting support for accessible role buttons and a stricter readiness check. A live Canva presentation page still needs to be checked in Chrome; require a manual Present/View check before claiming the issue is fixed.

## Files and release

- `extension/content/canva-content.js`: activate the labeled Canva controls and return accurate acceptance results.
- `tests/canva-extension.test.js`: cover previous/next activation, missing/disabled/ambiguous controls, and readiness rejection.
- `src/mobile-remote-phone.js` and `tests/mobile-remote-phone.test.js`: make the Canva acknowledgement describe dispatch rather than confirmed slide movement.
- `extension/manifest.json`: bump patch version from `0.1.0` to `0.1.1` for this user-facing extension change; do not add the `debugger` permission.
- `README.md`: document that Canva control uses the presentation buttons and retains the current Present/View and extension-reload setup.

## Verification and limits

Run the focused Canva extension and phone tests, then `npm run check`, `npm run lint`, and `npm test` because this change crosses the extension-to-phone behavior. Unit tests establish the local command contract only. Manually verify Previous and Next on a real signed-in Canva Present tab and a View tab in Chrome, with a paired phone, and confirm no debugger warning appears. Do not claim live Canva navigation works until that manual check succeeds.
