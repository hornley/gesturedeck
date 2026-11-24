import test from 'node:test';
import assert from 'node:assert/strict';

class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.listeners = new Map();
    this.hidden = false;
    this.value = '7';
    this.textContent = '';
  }

  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
}

test('dashboard sends the API logout contract and renders both daily funnel metrics', async () => {
  const ids = ['login-panel', 'login-form', 'password', 'dashboard', 'range', 'totals', 'daily-rows', 'status', 'logout'];
  const elements = new Map(ids.map((id) => [`#${id}`, new Element()]));
  const calls = [];
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  globalThis.document = {
    querySelector: (selector) => elements.get(selector),
    createElement: (tag) => new Element(tag),
  };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.startsWith('/api/usage-analytics/summary')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          totals: {
            pdfImports: 3, phoneConnectedSessions: 4, pdfAndPhoneSessions: 2,
            phoneNavigationSessions: 1, completedPresentations: 0, averagePresentationSeconds: 0,
          },
          daily: [{
            date: '2026-11-25', pdf_imports: 3, phone_connected_sessions: 4,
            pdf_and_phone_sessions: 2, phone_navigation_sessions: 1,
            completed_presentations: 0, presentation_seconds: 0,
          }],
        }),
      };
    }
    return { ok: true, status: 200 };
  };

  try {
    await import(`../analytics.js?test=${Date.now()}`);
    await new Promise((resolve) => setImmediate(resolve));

    const cells = elements.get('#daily-rows').children[0].children;
    assert.deepEqual(cells.slice(3, 5).map((cell) => cell.textContent), ['2', '1']);

    await elements.get('#logout').listeners.get('click')();
    const logoutCall = calls.find(({ url }) => url === '/api/usage-analytics/logout');
    assert.equal(logoutCall.options.method, 'POST');
    assert.equal(logoutCall.options.headers['content-type'], 'application/json');
    assert.equal(logoutCall.options.body, JSON.stringify({}));
  } finally {
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
  }
});
