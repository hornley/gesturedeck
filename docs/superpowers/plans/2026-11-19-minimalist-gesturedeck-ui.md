# Minimalist GestureDeck UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the approved Warm clarity design across GestureDeck's landing page, presenter workspace, phone remote, and Canva extension popup, with Canva setup and readiness easy to understand.

**Issue:** [hornley/GestureDeck#22](https://github.com/hornley/GestureDeck/issues/22)

**Architecture:** Keep the current vanilla HTML surfaces and DOM IDs. Align their existing CSS files around one warm light palette and consistent type/action hierarchy; preserve all UI state and connection logic. Bump the extension version because its packaged popup stylesheet changes.

**Tech Stack:** HTML, CSS, existing JavaScript state renderers, Chrome Manifest V3, Node.js test runner.

---

## File map

- `home.css`: landing page color tokens, type, hero, preview, and responsive layout.
- `styles.css`: workspace canvas, deck/source controls, fullscreen toolbar, and pairing dialog.
- `mobile-remote.css`: phone remote colors, status, inputs, and touch controls.
- `extension/popup/popup.css`: popup typography, status hierarchy, and action styling.
- `extension/manifest.json`: one patch version increment for the packaged popup style change.
- `tests/`: no behavior or DOM IDs change. Existing tests remain the regression checks; update a fixture only if implementation changes markup despite this plan.

## Task 1: Align the color and type tokens

**Files:** `home.css`, `styles.css`, `mobile-remote.css`, `extension/popup/popup.css`

- [ ] **Step 1: Set the shared warm palette in each stylesheet root**

Use these shared values, keeping each file's existing token names where practical:

```css
--paper: oklch(97% 0.012 96);
--surface: oklch(99% 0.006 96);
--surface-soft: oklch(95% 0.012 96);
--ink: oklch(29% 0.018 145);
--muted: oklch(48% 0.018 130);
--line: oklch(87% 0.012 96);
--clay: oklch(49% 0.085 42);
--clay-dark: oklch(41% 0.08 42);
--moss: oklch(46% 0.04 145);
--serif: Georgia, "Times New Roman", serif;
--sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
```

Map existing rust/accent/signal variables to clay, and olive/good variables to moss. Keep error and warning colors distinct and readable. Use `color-scheme: light` on the phone remote and popup.

- [ ] **Step 2: Remove dark gradients and replace page backgrounds with the paper token**

Set each page body's background directly to its paper token. In `mobile-remote.css`, the current `--ink` token is used as the background and `--paper` as foreground; remap their definitions and uses so `--paper` is the background and `--ink` is the foreground. Map panels to `--surface`/`--surface-soft`; remove the radial and linear background gradients.

```css
body {
  background: var(--paper);
  color: var(--ink);
}
```

- [ ] **Step 3: Check for leftover theme conflicts**

Run `rg -n "radial-gradient|linear-gradient|color-scheme: dark" home.css styles.css mobile-remote.css extension/popup/popup.css`.
Expected at this stage: only the landing page's `.preview-halo` radial gradient remains; no page background uses a gradient and no dark color scheme remains. Remove the halo rule in Task 2.

- [ ] **Step 4: Commit the shared theme pass**

```bash
git add home.css styles.css mobile-remote.css extension/popup/popup.css
git commit -m "style: unify GestureDeck color tokens"
```

## Task 2: Simplify the landing page

**Files:** `home.css`

- [ ] **Step 1: Remove decorative depth from the preview**

Use the existing slide and phone preview, but remove the original `.preview-halo` rule and replace it with `display: none`; remove rotation and strong shadows. Keep the slide preview as the main visual and align the phone preview to it without obscuring the slide title.

```css
.preview-halo { display: none; }
.slide-preview,
.phone-preview { transform: none; box-shadow: none; }
```

- [ ] **Step 2: Apply the type and action hierarchy**

Use `--serif` for the hero title, `--sans` for navigation and privacy copy, and `--clay` for the single primary action. Keep the privacy note visible below the action and preserve the existing mobile stacking breakpoint.

```css
.hero h1 { font-family: var(--serif); }
.primary-action {
  border-color: var(--clay);
  background: var(--clay);
  box-shadow: none;
}
```

- [ ] **Step 3: Commit the landing page pass**

```bash
git add home.css
git commit -m "style: simplify the GestureDeck landing page"
```

## Task 3: Reduce workspace panel noise

**Files:** `styles.css`

- [ ] **Step 1: Make the slide canvas the strongest surface**

Keep the existing workspace grid and slide DOM. Remove heavy shadows and repeated rounded-card treatment from `.deck-panel` and `.session-panel`; use whitespace and a thin divider to separate controls. Keep the slide canvas on `--surface-soft` with a subtle border.

```css
.deck-panel,
.session-panel {
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
```

- [ ] **Step 2: Keep the primary actions and pairing state easy to scan**

Use clay for the active Next/primary action, neutral surface styling for Sample deck/Open a PDF/Connect phone, and moss for connected states. Reduce decoration in `.deck-choice-button` and the dialog, while retaining QR, URL, paired-phone list, renewal, disconnect, status, and error content.

```css
.deck-choice-button { background: var(--surface); }
.deck-choice-button[data-selected="true"] {
  border-color: var(--moss);
  background: var(--surface-soft);
}
.button-primary { background: var(--clay); box-shadow: none; }
```

- [ ] **Step 3: Commit the workspace pass**

```bash
git add styles.css
git commit -m "style: clarify the presenter workspace"
```

## Task 4: Apply Warm clarity to the phone remote

**Files:** `mobile-remote.css`

- [ ] **Step 1: Convert the remote to the shared light surface**

Use paper behind the controls, one surface for pairing/status groups, charcoal text, clay for Connect/Next, and moss for successful connection. Remove glowing dots and decorative gradients; preserve the textual `data-state` colors for connected and error states.

```css
.connection-panel,
.pairing-panel { background: var(--surface); border-color: var(--line); }
.connection-light { box-shadow: none; }
.connection-copy[data-state="connected"] { color: var(--moss); }
.transport-button { min-height: 48px; }
.transport-button--next { background: var(--clay); }
```

- [ ] **Step 2: Keep navigation thumb-friendly**

Keep both transport buttons at least 48px high and wide, with the clay action clearly primary. Retain the slide-number input and Go control for decks/PDFs and all existing focus, safe-area, landscape, and reduced-motion rules.

- [ ] **Step 3: Commit the phone remote pass**

```bash
git add mobile-remote.css
git commit -m "style: simplify the phone remote"
```

## Task 5: Clarify the Canva popup visually

**Files:** `extension/popup/popup.css`, `extension/manifest.json`

- [ ] **Step 1: Style the existing status and actions as a short setup flow**

Keep `popup.html`, `popup.js`, all IDs, and the current state copy unchanged. Give `#status` the strongest text hierarchy after the heading, style `.hint` as the immediate next step, keep Connect as the primary action, and style Show phone QR/link as secondary. Preserve the disabled appearance when disconnected and the enabled pairing action when connected but not ready.

- [ ] **Step 2: Keep keyboard focus and contrast visible at popup size**

Use the shared token values, maintain full-width buttons with a 44px minimum height, readable text at the existing 280px width, and a visible 2-3px focus ring with adequate contrast.

```css
#status {
  padding: 10px 0;
  color: var(--ink);
  font-weight: 600;
}
.hint { color: var(--muted); line-height: 1.45; }
button { min-height: 44px; }
button:focus-visible { outline: 3px solid var(--moss); outline-offset: 2px; }
```

- [ ] **Step 3: Bump the packaged extension version once**

Change `extension/manifest.json` from `"version": "0.1.1"` to `"version": "0.1.2"`.

- [ ] **Step 4: Commit the popup pass**

```bash
git add extension/popup/popup.css extension/manifest.json
git commit -m "style: clarify the Canva extension popup"
```

## Task 6: Review the complete user flow

**Files:** no additional files unless a regression is found.

- [ ] **Step 1: Check the patch for unintended file and whitespace changes**

```bash
git diff --check
git status --short --branch
```

- [ ] **Step 2: Confirm the implementation stayed presentation-only**

Run `git diff hornley/main...HEAD -- app.js src extension/shared extension/background api server.mjs`. Expected: no connection logic, API, relay, or protocol changes. Confirm `extension/manifest.json` is the only extension metadata change.

- [ ] **Step 3: Inspect the surfaces at their target widths**

Check the landing page and workspace at desktop and narrow widths, the phone remote near 390px wide, and the extension popup at 280px. Confirm status and error messages remain legible, the canvas remains primary, and tap/focus targets remain usable.

- [ ] **Step 4: Preserve the existing behavior contracts**

```bash
rg -n "aria-live|focus-visible|prefers-reduced-motion" home.css styles.css mobile-remote.css extension/popup/popup.css
```

Expected: existing live statuses, focus styles, and reduced-motion rules remain present. No tests are added because no behavior or DOM IDs change.

## Self-review against the spec

- All four surfaces have implementation tasks; Canva setup and its unready/ready states remain explicit through the existing status and hint copy.
- Existing DOM IDs and behavior are preserved, so no backend, Redis, origin, or message-protocol work is introduced.
- Accessibility requirements are covered in the workspace, phone remote, and popup tasks.
- The extension patch version is bumped once because its packaged CSS changes.
- Existing tests remain unchanged because the plan preserves markup IDs and JavaScript state behavior.
