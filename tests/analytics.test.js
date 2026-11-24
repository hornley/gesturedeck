import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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

test('dashboard headers align with daily metrics and sends the API logout contract', async () => {
  const html = await readFile(new URL('../analytics.html', import.meta.url), 'utf8');
  const headers = [...html.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map(([, label]) => label);
  assert.deepEqual(headers, [
    'Date', 'PDF imports', 'Phone sessions', 'PDF and phone sessions',
    'Phone navigation sessions', 'Completed presentations', 'Presentation time',
  ]);
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
    const values = cells.map((cell) => cell.textContent);
    assert.equal(headers.length, values.length);
    assert.deepEqual(values, ['2026-11-25', '3', '4', '2', '1', '0', '0 min']);

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
