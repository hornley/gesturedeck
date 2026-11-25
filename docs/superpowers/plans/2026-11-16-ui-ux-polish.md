# UI/UX Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the tablet layout, deck-description contrast, keyboard discoverability, and stale presentation labels without changing slide-control behavior or remote contracts.

**Architecture:** Keep the existing vanilla HTML/CSS/JavaScript structure. Use one tablet grid track for the existing control column, update the shared visible copy in both static and cloud-mode paths, and extend the current `node:test` coverage with source-level assertions.

**Tech Stack:** Vanilla HTML, CSS, JavaScript, Node.js `node:test`, ESLint.

---

## File map

- `styles.css` owns the workspace responsive grid and deck-choice typography.
- `index.html` owns the public-home navigation label.
- `workspace.html` owns the static workspace hint and setup heading.
- `app.js` owns the cloud-mode replacement for the workspace hint and the existing unchanged `ArrowLeft`/`ArrowRight` handler.
- `tests/app.test.js` owns static workspace markup, stylesheet, and app-source regression assertions.

No extension, server, remote, PDF, or README files need changes for this issue.

### Task 1: Add regression tests for the approved behavior

**Files:**
- Modify: `tests/app.test.js:74-78`

- [ ] **Step 1: Extend the tablet CSS test with the control-column assertion.**

Keep the existing `.workspace-grid` assertion and add this assertion inside `test('workspace stacks presentation and controls at tablet widths', ...)`:

```js
assert.match(tabletStyles, /\.control-column\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/);
```

- [ ] **Step 2: Add a focused copy and contrast regression test.**

Add this test after the tablet CSS test. It reads all three user-visible copy paths and the deck-description rule:

```js
test('workspace copy names the current presentation flow', async () => {
  const [homeHtml, workspaceHtml, appSource, css] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../workspace.html', import.meta.url), 'utf8'),
    readFile(new URL('../app.js', import.meta.url), 'utf8'),
    readFile(new URL('../styles.css', import.meta.url), 'utf8'),
  ]);

  assert.match(homeHtml, /<a class="local-link" href="\/workspace\.html">Presentation workspace<\/a>/);
  assert.match(workspaceHtml, /<p class="welcome-description">Choose a deck, then present with the left and right arrow keys or your phone\.<\/p>/);
  assert.match(workspaceHtml, /<h2 id="session-heading">Set up your presentation<\/h2>/);
  assert.match(appSource, /setText\(document\.querySelector\('\.welcome-description'\), 'Choose a PDF, pair your phone, and present with the left and right arrow keys\.'\)/);
  assert.match(css, /\.deck-choice-copy > span\s*\{[\s\S]*?color:\s*#696d64;/);
});
```

- [ ] **Step 3: Run the focused test and verify it fails on the unimplemented behavior.**

Run:

```bash
node --test tests/app.test.js
```

Expected: the existing tests run, and the new tablet/copy assertions fail because the current CSS and strings still use the old values.

### Task 2: Implement the minimal CSS and copy changes

**Files:**
- Modify: `styles.css:313-319,1172-1175`
- Modify: `index.html:26`
- Modify: `workspace.html:35,120`
- Modify: `app.js:1037`

- [ ] **Step 1: Fix the tablet control grid.**

In the `@media (max-width: 860px)` block, replace the two-track declaration with one full-width track and keep the existing alignment:

```css
.control-column {
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
}
```

Do not change the `@media (max-width: 620px)` rule; it already uses one track and still owns the narrower mobile spacing.

- [ ] **Step 2: Raise the deck-choice description color.**

In `.deck-choice-copy > span`, change only the color declaration:

```css
color: #696d64;
```

This gives 4.93:1 contrast on `#f8f7f2` and keeps the existing font size and layout.

- [ ] **Step 3: Update the static home and workspace labels.**

Change the exact text values without changing links, IDs, roles, or button behavior:

```html
<a class="local-link" href="/workspace.html">Presentation workspace</a>
<p class="welcome-description">Choose a deck, then present with the left and right arrow keys or your phone.</p>
<h2 id="session-heading">Set up your presentation</h2>
```

- [ ] **Step 4: Keep the cloud-mode hint equally discoverable.**

In `app.js`, update only the string assigned at the existing cloud-mode replacement:

```js
setText(document.querySelector('.welcome-description'), 'Choose a PDF, pair your phone, and present with the left and right arrow keys.');
```

Leave the `ArrowLeft`/`ArrowRight` keyboard handler and all element IDs unchanged.

- [ ] **Step 5: Re-run the focused test.**

Run:

```bash
node --test tests/app.test.js
```

Expected: all tests in `tests/app.test.js` pass, including the new responsive, contrast, and copy assertions.

### Task 3: Run repository checks and commit the implementation

**Files:**
- Verify: `styles.css`, `index.html`, `workspace.html`, `app.js`, `tests/app.test.js`

- [ ] **Step 1: Run JavaScript syntax checks.**

Run:

```bash
npm run check
```

Expected: exit 0 with every existing `node --check` command passing.

- [ ] **Step 2: Run lint.**

Run:

```bash
npm run lint
```

Expected: exit 0 with no new ESLint findings.

- [ ] **Step 3: Review the final diff for scope and whitespace.**

Run:

```bash
git diff --check
git diff -- styles.css index.html workspace.html app.js tests/app.test.js
```

Confirm the diff contains only the one tablet rule, one color, four copy updates, and focused assertions. Confirm the keyboard handler and all control IDs are unchanged.

- [ ] **Step 4: Commit the implementation.**

Run:

```bash
git add styles.css index.html workspace.html app.js tests/app.test.js
git commit -m "fix: polish presentation workspace UX"
```

Expected: one commit containing the five implementation files, with the worktree clean afterward.

## Self-review checklist

- The tablet requirement maps to Task 1 Step 1 and Task 2 Step 1.
- The contrast requirement maps to Task 1 Step 2 and Task 2 Step 2.
- Static and cloud keyboard discoverability map to Task 1 Step 2 and Task 2 Steps 3–4.
- Existing keyboard behavior and all remote/PDF contracts are explicitly preserved in Task 2 Step 4 and Task 3 Step 3.
- No placeholders or unbounded refactors remain in the plan.
