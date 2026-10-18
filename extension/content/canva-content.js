(() => {
  if (globalThis.__gestureDeckCanvaContent) return;
  globalThis.__gestureDeckCanvaContent = true;

  function isPresentationMode() {
    return /\/(?:present|view)(?:\/|$)/.test(location.pathname);
  }

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
