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

  function reportReadiness() {
    void chrome.runtime.sendMessage({ type: 'target-readiness', ready: isPresentationMode() }).catch(() => {});
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
  reportReadiness();
})();
