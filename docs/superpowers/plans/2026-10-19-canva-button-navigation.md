# Canva Button Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make phone Previous/Next activate Canva’s accessible presentation buttons and show an acknowledgement that accurately describes button activation.

**Architecture:** Preserve the selected-tab extension flow, target-generation guard, and narrow Canva state. Replace synthetic keys with a guarded click on exactly one enabled button labeled Previous page or Next page. Tell the phone “Navigation sent to Canva,” bump the extension patch version, and document the limits.

**Tech Stack:** Vanilla JavaScript, Chrome Manifest V3, Node.js test runner, ESLint.

---

## File map

- extension/content/canva-content.js handles tab-scoped navigation, route readiness, and Canva button activation.
- tests/canva-extension.test.js tests the content script, rejection cases, extension permissions, and version.
- src/mobile-remote-phone.js renders command acknowledgements.
- tests/mobile-remote-phone.test.js tests the Canva and local acknowledgement wording.
- extension/manifest.json carries the extension release version, bumped from 0.1.0 to 0.1.1 for this user-facing extension change.
- README.md documents the Canva control behavior and acknowledgement limit.

### Task 1: Activate Canva’s labeled presentation buttons

**Files:**
- Modify: extension/content/canva-content.js
- Test: tests/canva-extension.test.js

- [ ] **Step 1: Replace the content-script test with button-control coverage**

In tests/canva-extension.test.js, replace the test “Canva content script dispatches arrow keys only on presentation routes” with:

~~~js
test('Canva content script clicks one enabled labeled button on presentation routes', async () => {
  const source = await readFile(new URL('../extension/content/canva-content.js', import.meta.url), 'utf8');
  const messages = [];
  const handlers = [];
  const location = { pathname: '/design/deck-1/present' };
  const makeButton = (label, { disabled = false, ariaDisabled = null, throws = false } = {}) => ({
    disabled,
    clicks: 0,
    getAttribute(name) {
      if (name === 'aria-label') return label;
      if (name === 'aria-disabled') return ariaDisabled;
      return null;
    },
    click() {
      this.clicks += 1;
      if (throws) throw new Error('click failed');
    },
  });
  let buttons = [makeButton('Previous page'), makeButton('Next page')];
  const context = {
    location,
    chrome: { runtime: {
      onMessage: { addListener: (callback) => handlers.push(callback) },
      sendMessage: (message) => { messages.push(message); return Promise.resolve(); },
    } },
    window: { addEventListener() {} },
    document: { querySelectorAll: (selector) => {
      assert.equal(selector, 'button[aria-label]');
      return buttons;
    } },
  };
  context.globalThis = context;
  runInNewContext(source, context);
  const receive = (message) => {
    let response;
    handlers[0](message, {}, (value) => { response = value; });
    return response;
  };

  assert.equal(receive({ type: 'probe' }).ready, true);
  assert.deepEqual(receive({ type: 'keypress', key: 'ArrowRight' }), { accepted: true, ready: true });
  assert.deepEqual(buttons.map(({ clicks }) => clicks), [0, 1]);
  buttons = [makeButton('  PREVIOUS\n  page  ')];
  assert.deepEqual(receive({ type: 'keypress', key: 'ArrowLeft' }), { accepted: true, ready: true });
  assert.equal(buttons[0].clicks, 1);
  assert.equal(receive({ type: 'keypress', key: 'Home' }), undefined);

  for (const unavailableButtons of [
    [],
    [makeButton('Next page', { disabled: true })],
    [makeButton('Next page', { ariaDisabled: 'true' })],
    [makeButton('Next page'), makeButton(' Next   page ')],
  ]) {
    buttons = unavailableButtons;
    assert.deepEqual(receive({ type: 'keypress', key: 'ArrowRight' }), { accepted: false, ready: true });
    assert.equal(buttons.reduce((total, button) => total + button.clicks, 0), 0);
  }

  buttons = [makeButton('Next page', { throws: true })];
  assert.deepEqual(receive({ type: 'keypress', key: 'ArrowRight' }), { accepted: false, ready: true });
  assert.equal(buttons[0].clicks, 1);

  location.pathname = '/design/deck-1/edit';
  buttons = [makeButton('Previous page')];
  assert.equal(receive({ type: 'probe' }).ready, false);
  assert.deepEqual(receive({ type: 'keypress', key: 'ArrowLeft' }), { accepted: false, ready: false });
  assert.equal(buttons[0].clicks, 0);
  assert.equal(messages.some(({ type }) => type === 'target-readiness'), true);
});
~~~

- [ ] **Step 2: Run the focused extension test and confirm the new behavior fails**

Run: node --test tests/canva-extension.test.js

Expected: the new test fails because the current handler dispatches KeyboardEvents rather than clicking fake Canva buttons. Other extension tests continue to pass.

- [ ] **Step 3: Implement guarded button activation**

In extension/content/canva-content.js, remove synthetic keydown/keyup dispatch. Add after isPresentationMode():

~~~js
  function normalizeAccessibleName(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function findNavigationButton(label) {
    const matches = [...document.querySelectorAll('button[aria-label]')]
      .filter((button) => normalizeAccessibleName(button.getAttribute('aria-label')) === label);
    if (matches.length !== 1) return null;

    const [button] = matches;
    if (button.disabled || normalizeAccessibleName(button.getAttribute('aria-disabled')) === 'true') return null;
    return button;
  }
~~~

In the existing keypress listener, keep the message/key allowlist and early rejection when the route is not ready. Replace the key assignment and event loop with:

~~~js
    try {
      const label = message.key === 'ArrowLeft' ? 'previous page' : 'next page';
      const button = findNavigationButton(label);
      if (!button) {
        sendResponse({ accepted: false, ready: true });
        return false;
      }
      button.click();
      sendResponse({ accepted: true, ready: true });
    } catch {
      sendResponse({ accepted: false, ready: isPresentationMode() });
    }
~~~

Leave readiness reporting, probing, route checks, and popstate/hashchange listeners unchanged. Do not add debugger permission or change message actions.

- [ ] **Step 4: Run the focused extension test and confirm it passes**

Run: node --test tests/canva-extension.test.js

Expected: all extension tests pass. One matching enabled button is clicked; missing, disabled, ambiguous, throwing, and unready cases are rejected.

- [ ] **Step 5: Commit Task 1**

~~~bash
git add extension/content/canva-content.js tests/canva-extension.test.js
git commit -m "fix: click Canva presentation controls"
~~~

### Task 2: Make phone acknowledgements describe dispatch

**Files:**
- Modify: src/mobile-remote-phone.js
- Test: tests/mobile-remote-phone.test.js

- [ ] **Step 1: Replace the generic acknowledgement test with Canva and local assertions**

Replace the existing test “command acknowledgements update action status” in tests/mobile-remote-phone.test.js with:

~~~js
test('Canva phone acknowledgement reports that navigation was sent', () => {
  const result = setup();
  paired(result, { target: 'canva', ready: true, index: null, total: null, busy: false });
  result.document.getElementById('next-button').dispatch('click');
  const command = result.socket.sent.at(-1);
  result.socket.message({ type: 'commandAck', id: command.id, accepted: true });
  assert.equal(result.document.getElementById('action-status').textContent, 'Navigation sent to Canva.');
});

test('local deck phone keeps the generic presenter acknowledgement', () => {
  const result = setup();
  paired(result);
  result.document.getElementById('next-button').dispatch('click');
  const command = result.socket.sent.at(-1);
  result.socket.message({ type: 'commandAck', id: command.id, accepted: true });
  assert.equal(result.document.getElementById('action-status').textContent, 'Command accepted by presenter.');
});
~~~

- [ ] **Step 2: Run the focused phone test and confirm the Canva case fails**

Run: node --test tests/mobile-remote-phone.test.js

Expected: the Canva assertion fails with “Command accepted by presenter.”; the local deck assertion passes.

- [ ] **Step 3: Render target-specific success wording**

In src/mobile-remote-phone.js, replace the current commandAck status assignment with:

~~~js
      actionStatus.textContent = message.accepted
        ? currentState?.target === 'canva'
          ? 'Navigation sent to Canva.'
          : 'Command accepted by presenter.'
        : 'Command was not accepted. Check the presentation connection and try again.';
~~~

Leave rejection wording and command ID handling unchanged. This acknowledgement confirms dispatch only, not an observed slide change.

- [ ] **Step 4: Run the focused phone test and confirm both cases pass**

Run: node --test tests/mobile-remote-phone.test.js

Expected: the Canva and local acknowledgement assertions and all remaining phone tests pass.

- [ ] **Step 5: Commit Task 2**

~~~bash
git add src/mobile-remote-phone.js tests/mobile-remote-phone.test.js
git commit -m "fix: clarify Canva navigation acknowledgements"
~~~

### Task 3: Record the extension release and user-facing behavior

**Files:**
- Modify: extension/manifest.json
- Modify: tests/canva-extension.test.js
- Modify: README.md

- [ ] **Step 1: Add a release-version assertion**

In the test “extension permissions stay limited to the selected tab and approved controller origins” in tests/canva-extension.test.js, add immediately after parsing the manifest:

~~~js
  assert.equal(manifest.version, '0.1.1');
~~~

Run: node --test tests/canva-extension.test.js

Expected: this assertion fails because the manifest still says 0.1.0. The existing permission assertion must continue to require exactly activeTab, scripting, and storage.

- [ ] **Step 2: Bump the extension version and document its behavior**

In extension/manifest.json, change only the version from 0.1.0 to 0.1.1.

In README.md, extend the Canva setup paragraph after the readiness explanation and before “The hosted workspace must stay open during a hosted Canva session.” Add:

~~~text
On a phone command, the extension activates one enabled Canva presentation button labeled “Previous page” or “Next page”; the phone’s “Navigation sent to Canva” status confirms the button was activated, not that Canva’s slide changed. If Canva changes those button labels or markup, navigation may stop working. Check Previous and Next in a signed-in Present or View tab after updating the unpacked extension.
~~~

Keep the existing origin allowlist, Present/View setup, and extension reload instruction. Do not add debugger permission.

- [ ] **Step 3: Run the focused extension test and review the diff**

Run: node --test tests/canva-extension.test.js

Expected: all extension tests pass, the version is 0.1.1, and permissions remain unchanged.

Review: git diff --check && git diff -- extension/manifest.json README.md tests/canva-extension.test.js

Expected: this task adds only the patch version, its assertion, and Canva control/acknowledgement documentation.

- [ ] **Step 4: Commit Task 3**

~~~bash
git add extension/manifest.json README.md tests/canva-extension.test.js
git commit -m "docs: describe Canva button navigation"
~~~

## Final verification

After all three tasks have been reviewed and integrated, run:

~~~bash
node --test tests/canva-extension.test.js
node --test tests/mobile-remote-phone.test.js
npm run check
npm run lint
npm test
git diff --check
~~~

Expected: every command exits successfully. Tests verify local contracts only. Before reporting live Canva navigation as confirmed, manually pair a phone and try Previous/Next on signed-in Canva Present and View tabs in Chrome; verify slides move and no debugger warning appears. Until then, report live Canva DOM compatibility as unverified.

## Plan self-review

- **Spec coverage:** label normalization, unique enabled match, missing/disabled/ambiguous/throwing rejection, unready rejection, accurate phone acknowledgement, no debugger permission, patch bump, README, and manual Present/View check all have explicit steps.
- **Placeholder scan:** no TBD/TODO or unspecified implementation instructions remain; code, paths, commands, outcomes, and commit messages are provided.
- **Consistency:** arrow keys map to the tested normalized labels; phone wording checks currentState.target === 'canva'; version is 0.1.1; selected-tab and relay boundaries stay unchanged.
