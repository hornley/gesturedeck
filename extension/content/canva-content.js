(() => {
  if (globalThis.__gestureDeckCanvaContent) return;
  globalThis.__gestureDeckCanvaContent = true;

  function normalizeAccessibleName(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function getNavigationControls() {
    return [...document.querySelectorAll('button[aria-label], [role="button"][aria-label]')];
  }

  function hasPresentationControls() {
    return getNavigationControls().some((control) => {
      const label = normalizeAccessibleName(control.getAttribute('aria-label'));
      return label === 'previous page' || label === 'next page';
    });
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

  function reportReadiness() {
    const ready = isPresentationMode();
    if (ready === lastReportedReady) return;
    lastReportedReady = ready;
    void chrome.runtime.sendMessage({ type: 'target-readiness', ready }).catch(() => {});
  }

  function scheduleReadinessReport() {
    clearTimeout(readinessTimer);
    readinessTimer = setTimeout(reportReadiness, 100);
  }

  function isNavigationLabel(value) {
    const label = normalizeAccessibleName(value);
    return label === 'previous page' || label === 'next page';
  }

  function isRelevantNavigationControl(control, label = control?.getAttribute?.('aria-label')) {
    if (!control || !isNavigationLabel(label)) return false;
    return control.tagName === 'BUTTON' || normalizeAccessibleName(control.getAttribute('role')) === 'button';
  }

  function containsRelevantNavigationControl(node) {
    if (isRelevantNavigationControl(node)) return true;
    return [...(node?.querySelectorAll?.('button[aria-label], [role="button"][aria-label]') ?? [])]
      .some((control) => isRelevantNavigationControl(control));
  }

  function hasRelevantReadinessMutation(records) {
    return records.some((record) => {
      if (record.type === 'childList') {
        return [...record.addedNodes, ...record.removedNodes].some(containsRelevantNavigationControl);
      }
      if (record.type !== 'attributes') return false;
      const { target, attributeName, oldValue } = record;
      if (attributeName === 'aria-label') {
        return isRelevantNavigationControl(target, oldValue) || isRelevantNavigationControl(target);
      }
      if (attributeName === 'role') {
        return (normalizeAccessibleName(oldValue) === 'button' || normalizeAccessibleName(target.getAttribute('role')) === 'button')
          && isNavigationLabel(target.getAttribute('aria-label'));
      }
      return ['aria-disabled', 'disabled'].includes(attributeName) && isRelevantNavigationControl(target);
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
