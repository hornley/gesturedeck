# Canva Route Readiness

## Goal

Allow phone navigation as soon as the connected Canva tab is on a `/view` or `/present` route. Both routes count as ready based on the URL, matching the earlier debugger-based behavior.

## Scope

Change readiness detection in `extension/content/canva-content.js`. Keep the existing URL validation, selected-tab checks, debugger dispatch, and narrow Previous/Next commands unchanged. Update `tests/canva-extension.test.js` to verify both routes are ready without labeled navigation controls and that editor routes remain not ready.

## Verification

Run the focused Canva extension test, then the repository JavaScript checks and lint. This verifies the content script's route decision and existing extension wiring; it does not establish live Canva behavior.
