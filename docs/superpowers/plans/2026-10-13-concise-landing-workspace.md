# Concise Landing Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GestureDeck’s first screen a concise, usable presentation workspace with the sample deck, PDF and phone choices, and short setup instructions.

**Architecture:** Keep the existing single-page vanilla HTML interface and presentation/phone state. Reorganize semantic markup and CSS while preserving IDs that `app.js` already uses; keep the existing sample-deck and phone actions.

**Tech Stack:** HTML, CSS, vanilla JavaScript ES modules, Node.js local server.

---

## File map

- `index.html` — page regions, deck-choice controls, concise setup steps, and phone pairing controls. Preserve IDs referenced by `app.js`.
- `styles.css` — two-column desktop arrangement, compact panel styles, disclosure styling, idle versus active session presentation, and narrow-screen stacking.
- `app.js` — keep sample-deck selection synchronized with PDF selection and restoration; existing phone and presentation handlers remain the source of behavior.

## Task 1: Recompose the workspace around the deck

**Files:**
- Modify: `index.html`
- Modify: `styles.css`

- [x] Keep `#deck-visual`, the PDF stage, fullscreen controls, slide position, progress, and `#previous-slide` / `#next-slide` in the main deck column.
- [x] Create a compact `aside` headed “Choose a deck” beside the deck. Move the existing `#open-pdf`, `#connect-phone`, `#sample-deck`, and `#pdf-file` controls into this panel without duplicating IDs.
- [x] Represent the sample deck as the selected default option. Keep `#sample-deck` visible, label it “Use sample deck” when a PDF is active, and mark it selected when the sample is active.
- [x] Keep `#pdf-status` and `#pdf-error` associated with the deck choice and preserve their status and alert roles.
- [x] Replace the current workspace grid rules with a deck-first two-column desktop grid. On narrow screens, place the deck first and stack the choice panel below it.

## Task 2: Shorten instructions and progressively disclose controls

**Files:**
- Modify: `index.html`
- Modify: `styles.css`

- [x] Keep the deck and phone instructions short, with the primary actions easy to find.

## Task 3: Preserve behavior and keep the page responsive

**Files:**
- Modify: `index.html`
- Modify: `styles.css`
- Modify: `app.js`

- [x] Move the existing `#sample-deck` action into the deck choice panel. Keep it visible as “Sample deck”; mark it selected while the built-in deck is active and label it “Use sample deck” while a PDF is active.
- [x] In `app.js`, update `#sample-deck` selected state alongside PDF loading and sample restoration without changing the current PDF or phone APIs.
- [x] Keep existing IDs used by `elements` intact, including `#open-pdf`, `#connect-phone`, and `#sample-deck`.
- [x] Ensure the deck choice buttons and phone actions have visible focus styles and usable touch targets. Preserve semantic labels and live announcements.
- [x] Honor the existing reduced-motion handling for transitions. Keep the layout rules free of horizontal scrolling at 320px and wider.

## Self-review

- The approved spec’s page structure maps to Tasks 1 and 2.
- Existing feature preservation and session state behavior map to Tasks 1–3.
- Responsive layout, focus, touch size, live announcements, and reduced motion map to Tasks 1 and 3.
- Existing control IDs stay stable; the existing sample-deck action serves both as the selected default state and as the PDF-to-sample switch.
- Source-level review is complete. Rendered UI inspection remains pending because `orca skills get computer-use --json` failed with `Unable to determine Orca.app path from symlink: /usr/local/bin/orca`; port `5173` was already in use.
