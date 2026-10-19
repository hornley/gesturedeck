(() => {
  if (globalThis.__gestureDeckCanvaContent) return;
  globalThis.__gestureDeckCanvaContent = true;

  function normalizeAccessibleName(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  const NAVIGATION_CONTROL_SELECTOR = 'button[aria-label], [role="button"][aria-label]';

  function isNavigationLabel(value) {
    const label = normalizeAccessibleName(value);
    return label === 'previous page' || label === 'next page';
  }

  function isLabeledNavigationControl(control, label = control?.getAttribute?.('aria-label')) {
    if (!control || !isNavigationLabel(label)) return false;
    return control.tagName === 'BUTTON' || normalizeAccessibleName(control.getAttribute('role')) === 'button';
  }

  function getNavigationControls() {
    return [...document.querySelectorAll(NAVIGATION_CONTROL_SELECTOR)];
  }

  function hasPresentationControls() {
    return getNavigationControls().some((control) => isLabeledNavigationControl(control));
  }

  function isPresentationMode() {
    return /\/(?:present|view)(?:\/|$)/.test(location.pathname) && hasPresentationControls();
  }

  function findNavigationButton(label) {
    const matches = getNavigationControls()
      .filter((control) => normalizeAccessibleName(control.getAttribute('aria-label')) === label);
    if (matches.length !== 1) return null;

    const [control] = matches;
    if (control.matches(':disabled') || normalizeAccessibleName(control.getAttribute('aria-disabled')) === 'true') return null;
    return control;
  }

  let lastReportedReady;
  let readinessTimer;
  let readinessMaxWaitTimer;

  function reportReadiness() {
    const ready = isPresentationMode();
    if (ready === lastReportedReady) return;
    lastReportedReady = ready;
    void chrome.runtime.sendMessage({ type: 'target-readiness', ready }).catch(() => {});
  }

  function flushReadinessReport() {
    clearTimeout(readinessTimer);
    clearTimeout(readinessMaxWaitTimer);
    readinessTimer = undefined;
    readinessMaxWaitTimer = undefined;
    reportReadiness();
  }

  function scheduleReadinessReport() {
    clearTimeout(readinessTimer);
    if (readinessMaxWaitTimer === undefined) {
      readinessMaxWaitTimer = setTimeout(flushReadinessReport, 500);
    }
    readinessTimer = setTimeout(flushReadinessReport, 100);
  }

  function containsRelevantNavigationControl(node) {
    if (isLabeledNavigationControl(node)) return true;
    return [...(node?.querySelectorAll?.(NAVIGATION_CONTROL_SELECTOR) ?? [])]
      .some((control) => isLabeledNavigationControl(control));
  }

  function hasRelevantReadinessMutation(records) {
    if (records.some((record) => {
      if (record.type === 'childList') {
        return [...record.addedNodes, ...record.removedNodes].some(containsRelevantNavigationControl);
      }
      return false;
    })) return true;

    const attributeMutations = new Map();
    for (const record of records) {
      if (record.type !== 'attributes') continue;
      const mutations = attributeMutations.get(record.target) ?? [];
      mutations.push(record);
      attributeMutations.set(record.target, mutations);
    }

    return [...attributeMutations].some(([target, mutations]) => {
      const oldValueFor = (attributeName) => mutations.find((record) => record.attributeName === attributeName)?.oldValue;
      const previousLabel = oldValueFor('aria-label') ?? target.getAttribute('aria-label');
      const previousRole = oldValueFor('role') ?? target.getAttribute('role');
      const wasRelevantControl = isNavigationLabel(previousLabel)
        && (target.tagName === 'BUTTON' || normalizeAccessibleName(previousRole) === 'button');
      return isLabeledNavigationControl(target) || wasRelevantControl;
    });
  }

  function handleReadinessMutations(records) {
    if (hasRelevantReadinessMutation(records)) scheduleReadinessReport();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'probe') {
      sendResponse({ ready: isPresentationMode() });
      return false;
    }
    if (message?.type !== 'keypress' || !['ArrowLeft', 'ArrowRight'].includes(message.key)) return false;
    if (!isPresentationMode()) {
      reportReadiness();
      sendResponse({ accepted: false, ready: false });
      return false;
    }
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
    return false;
  });

  for (const eventName of ['popstate', 'hashchange']) {
    window.addEventListener(eventName, reportReadiness);
  }
  if (document.documentElement) {
    const observer = new MutationObserver(handleReadinessMutations);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-label', 'aria-disabled', 'disabled', 'role'],
      attributeOldValue: true,
    });
  }
  reportReadiness();
})();
