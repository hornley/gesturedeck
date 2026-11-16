import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

class FakeElement {
  constructor(attributes = {}) {
    this.attributes = new Map(Object.entries(attributes));
    this.listeners = new Map();
    this.dataset = {};
    this.style = {};
    this.textContent = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.srcObject = null;
    this.children = [];
    this.open = false;
  }

  addEventListener(type, callback) {
    this.listeners.set(type, callback);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  dispatch(type, extra = {}) {
    return this.listeners.get(type)?.({ currentTarget: this, target: this, ...extra });
  }

  click() { this.dispatch('click'); }

  focus() {
    globalThis.document.activeElement = this;
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
    this.dispatch('close');
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  querySelector() {
    return new FakeElement();
  }
}

async function createPairingHarness({
  pageUrl = 'http://127.0.0.1:5173/workspace.html',
  initialExtensionState = { connected: false, ready: false },
} = {}) {
  const ids = [
    'connect-phone', 'pairing-dialog', 'pairing-interface', 'start-phone-remote',
    'pairing-qr-panel', 'pairing-qr', 'pairing-url-panel', 'pairing-url',
    'copy-pairing-url', 'pairing-status', 'new-pairing-link', 'disconnect-phone',
    'paired-phones-panel', 'paired-phones', 'paired-phones-empty', 'paired-phone-count',
    'close-pairing-dialog', 'slide-number', 'slide-count', 'deck-progress', 'previous-slide', 'next-slide', 'action-toast',
    'sample-deck', 'sample-deck-status', 'open-pdf', 'pdf-file',
    'deck-visual', 'target-status', 'sample-canvas-topline', 'sample-canvas-content', 'sample-canvas-footer',
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement()]));
  elements.get('start-phone-remote').disabled = true;
  const body = new FakeElement();
  const originalGlobals = new Map();
  const setGlobal = (name, value) => {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const documentListeners = new Map();
  const windowListeners = new Map();
  const location = new URL(pageUrl);
  const locationState = {
    protocol: location.protocol,
    host: location.host,
    hostname: location.hostname,
    origin: location.origin,
    search: location.search,
  };
  const fakeDocument = {
    body,
    documentElement: new FakeElement(),
    activeElement: null,
    visibilityState: 'visible',
    hasFocus: () => true,
    getElementById: (id) => elements.get(id) ?? null,
    querySelector: () => new FakeElement(),
    createElement: () => new FakeElement(),
    addEventListener: (type, callback) => documentListeners.set(type, callback),
    dispatchEvent(type, event) { return documentListeners.get(type)?.(event); },
  };
  setGlobal('document', fakeDocument);
  let extensionState = { ...initialExtensionState };
  const extensionRequests = [];
  const fakeWindow = {
    location: locationState,
    addEventListener(type, callback) {
      const listeners = windowListeners.get(type) ?? [];
      listeners.push(callback);
      windowListeners.set(type, listeners);
    },
    removeEventListener(type, callback) {
      windowListeners.set(type, (windowListeners.get(type) ?? []).filter((listener) => listener !== callback));
    },
    dispatchMessage(data, origin = this.location.origin) {
      for (const callback of windowListeners.get('message') ?? []) callback({ source: this, origin, data });
    },
    postMessage(message, targetOrigin) {
      extensionRequests.push(message);
      if (message?.source !== 'gesturedeck' || message.type !== 'canva-controller-request') return;
      const response = message.command === 'status'
        ? { source: 'gesturedeck-extension', type: 'canva-controller-response', id: message.id, command: 'status', state: { ...extensionState } }
        : { source: 'gesturedeck-extension', type: 'canva-controller-response', id: message.id, command: 'navigate', accepted: extensionState.connected && extensionState.ready };
      queueMicrotask(() => this.dispatchMessage(response, targetOrigin));
    },
  };
  const publishExtensionState = (nextState) => {
    extensionState = nextState;
    fakeWindow.dispatchMessage({ source: 'gesturedeck-extension', type: 'canva-target-state', ...nextState });
  };
  setGlobal('window', fakeWindow);
  setGlobal('location', locationState);
  let cameraRequests = 0;
  setGlobal('navigator', {
    mediaDevices: { getUserMedia: async () => { cameraRequests += 1; throw new Error('Camera should remain off.'); } },
    clipboard: { writeText: async () => {} },
  });
  setGlobal('localStorage', { getItem: () => '{}', setItem() {}, removeItem() {} });

  const calls = [];
  let startCount = 0;
  setGlobal('fetch', async (url, options = {}) => {
    const call = { url, options, body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    if (url === '/api/mobile-remote/interfaces') {
      return { ok: true, json: async () => ({ interfaces: ['192.168.1.20', '10.0.0.4'] }) };
    }
    if (url === '/api/mobile-remote/start') {
      startCount += 1;
      return { ok: true, json: async () => ({
        qrDataUrl: `data:image/png;base64,qr-${startCount}`,
        fallbackUrl: `http://192.168.1.20:43123/remote#invite-${startCount}`,
        hostCredential: 'host-secret',
      }) };
    }
    if (url === '/api/cloud-remote/start') {
      return { ok: true, json: async () => ({
        sessionId: 'abcdefghijklmnop',
        hostCredential: 'host-secret',
        qrDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        fallbackUrl: 'https://gesturedeck-two.vercel.app/r/abcdefghijklmnop#invite-secret',
      }) };
    }
    if (url === '/api/mobile-remote/renew-invite') {
      return { ok: true, json: async () => ({
        qrDataUrl: 'data:image/png;base64,renewed',
        fallbackUrl: 'http://192.168.1.20:43123/remote#renewed',
      }) };
    }
    if (url === '/api/mobile-remote/stop' || url === '/api/cloud-remote/stop') {
      return { ok: true, json: async () => ({ stopped: true }) };
    }
    throw new Error(`Unexpected fetch ${url}`);
  });

  const remoteSockets = [];
  class RemoteSocket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; RemoteSocket.instance = this; remoteSockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    open() { this.readyState = 1; this.onopen(); }
    message(value) { this.onmessage({ data: JSON.stringify(value) }); }
    close() { this.readyState = 3; this.onclose(); }
  }
  setGlobal('WebSocket', RemoteSocket);

  try {
    await import(`../app.js?pairing-test=${Date.now()}-${Math.random()}`);
  } catch (error) {
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    throw error;
  }
  return {
    elements,
    fakeDocument,
    fakeWindow,
    windowListeners,
    extensionRequests,
    publishExtensionState,
    calls,
    RemoteSocket,
    remoteSockets,
    get cameraRequests() { return cameraRequests; },
    restore() {
      for (const [name, descriptor] of originalGlobals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

test('workspace has no camera controls, capture copy, or camera module imports', async () => {
  const html = await readFile(new URL('../workspace.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  for (const id of [
    'start-setup', 'start-session', 'pause-session', 'resume-session', 'camera-preview',
    'camera-selection', 'camera-diagnostics', 'gesture-sensitivity', 'reverse-mapping',
  ]) assert.doesNotMatch(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /camera|webcam|swipe|hand tracking/i);
  assert.doesNotMatch(app, /camera-session|camera-preview|hand-tracking|local-hand-tracker|gesture-engine|getUserMedia/);
});

test('workspace keeps its sample deck, PDF, phone, and manual slide controls', async () => {
  const html = await readFile(new URL('../workspace.html', import.meta.url), 'utf8');
  for (const id of ['sample-deck', 'open-pdf', 'connect-phone', 'previous-slide', 'next-slide', 'pdf-file', 'pairing-dialog']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
  const compactDesktopStyles = css.slice(css.indexOf('@media (max-width: 1080px)'), css.indexOf('@media (max-width: 860px)'));
  assert.match(compactDesktopStyles, /\.keyboard-hint\s*\{\s*display:\s*none;/);
  const tabletStyles = css.slice(css.indexOf('@media (max-width: 860px)'), css.indexOf('@media (max-width: 620px)'));
  assert.match(tabletStyles, /\.workspace-grid\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/);
  assert.match(tabletStyles, /\.control-column\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/);
  assert.match(html, /← \/ → to navigate/);
});

test('home and workspace copy names the current presentation flow', async () => {
  const [homeHtml, workspaceHtml, appSource, css] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../workspace.html', import.meta.url), 'utf8'),
    readFile(new URL('../app.js', import.meta.url), 'utf8'),
    readFile(new URL('../styles.css', import.meta.url), 'utf8'),
  ]);

  assert.match(homeHtml, /<a class="local-link" href="\/workspace\.html">Presentation workspace<\/a>/);
  assert.doesNotMatch(homeHtml, /Local browser workspace/);
  assert.match(workspaceHtml, /<p class="welcome-description">Choose a sample deck or PDF, then present with the left and right arrow keys or phone controls\.<\/p>/);
  assert.match(workspaceHtml, /<p class="control-help">Use the Previous and Next buttons or the left and right arrow keys\.<\/p>/);
  assert.match(appSource, /setText\(document\.querySelector\('\.welcome-description'\), 'Choose a PDF, pair your phone, and present with the left and right arrow keys\.'\)/);
  assert.match(css, /\.deck-choice-copy > span\s*\{[\s\S]*?color:\s*#696d64;/);
});

test('manual buttons and unoccupied arrow keys navigate without requesting camera access', async () => {
  const app = await createPairingHarness();
  try {
    const { elements, fakeDocument } = app;
    const pressed = (key) => {
      let prevented = false;
      fakeDocument.dispatchEvent('keydown', {
        key, repeat: false, altKey: false, ctrlKey: false, metaKey: false,
        target: { closest: () => null }, preventDefault() { prevented = true; },
      });
      return prevented;
    };
    assert.equal(elements.get('slide-number').textContent, '01');
    assert.equal(app.cameraRequests, 0);
    elements.get('sample-deck').dispatch('click');
    await new Promise((resolve) => setImmediate(resolve));
    elements.get('open-pdf').dispatch('click');
    assert.equal(app.cameraRequests, 0);
    elements.get('next-slide').dispatch('click');
    assert.equal(elements.get('slide-number').textContent, '02');
    assert.equal(pressed('ArrowRight'), true);
    assert.equal(elements.get('slide-number').textContent, '03');
    assert.equal(pressed('ArrowLeft'), true);
    assert.equal(elements.get('slide-number').textContent, '02');
    assert.equal(app.cameraRequests, 0);
  } finally {
    app.restore();
  }
});

test('presenter pairing lists phones and disconnects one without affecting the session', async () => {
  const html = await readFile(new URL('../workspace.html', import.meta.url), 'utf8');
  const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(html, /<button id="connect-phone"[^>]*>/);
  const sourceUi = appSource.slice(appSource.indexOf('function renderSourceUi()'), appSource.indexOf('async function renderPdfPage'));
  assert.match(sourceUi, /show\(elements\.connectPhone, true\)/);
  assert.match(sourceUi, /pdfActive \? 'PDF · Local file' : 'Browser · Sample deck'/);
  assert.match(html, /<strong>Connect phone<\/strong>/);
  assert.doesNotMatch(html.match(/<button id="connect-phone"[^>]*>/)?.[0] ?? '', /hidden/);
  assert.match(html, /<dialog id="pairing-dialog"[^>]*aria-labelledby="pairing-title"/);
  assert.match(html, /<label[^>]*for="pairing-interface"[^>]*>Private network interface/);
  assert.match(html, /<label[^>]*for="pairing-url"[^>]*>Pairing URL/);
  for (const label of ['Start phone connection', 'Copy pairing URL', 'Renew pairing link', 'Disconnect all', 'Close']) {
    assert.match(html, new RegExp(`>${label.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')}<`));
  }

  const harness = await createPairingHarness();
  const {
    elements, fakeDocument, windowListeners, extensionRequests, publishExtensionState,
    calls, RemoteSocket, cameraRequests,
  } = harness;
  try {
    const connectButton = elements.get('connect-phone');
    assert.equal(connectButton.hidden, false, 'Connect phone is visible with the sample deck');
    connectButton.focus();
    await connectButton.dispatch('click');
    assert.equal(elements.get('pairing-dialog').open, true);
    assert.equal(fakeDocument.activeElement, elements.get('pairing-interface'));
    assert.deepEqual(calls.map(({ url }) => url), ['/api/mobile-remote/interfaces']);
    assert.deepEqual(elements.get('pairing-interface').children.map(({ value }) => value), ['', '192.168.1.20', '10.0.0.4']);
    assert.equal(cameraRequests, 0);
    assert.equal(calls.some(({ url }) => url.endsWith('/start')), false);

    elements.get('pairing-interface').value = '192.168.1.20';
    elements.get('pairing-interface').dispatch('change');
    assert.equal(elements.get('start-phone-remote').disabled, false);
    await elements.get('start-phone-remote').dispatch('click');
    const startCall = calls.find(({ url }) => url === '/api/mobile-remote/start');
    assert.deepEqual(startCall.body, { address: '192.168.1.20', state: { index: 0, total: 4, busy: false } });
    assert.equal(elements.get('pairing-qr-panel').hidden, true);
    assert.equal(elements.get('pairing-url-panel').hidden, true);
    assert.equal(elements.get('pairing-qr').src, '');
    assert.equal(elements.get('pairing-url').value, '');
    assert.equal(cameraRequests, 0);

    const socket = RemoteSocket.instance;
    socket.open();
    socket.message({ type: 'presenterReady' });
    assert.equal(elements.get('pairing-qr-panel').hidden, false);
    assert.equal(elements.get('pairing-qr').src, 'data:image/png;base64,qr-1');
    assert.equal(elements.get('pairing-url-panel').hidden, false);
    assert.equal(elements.get('pairing-url').value, 'http://192.168.1.20:43123/remote#invite-1');
    socket.message({ type: 'phones', phones: [
      { phoneId: 'phone-1', label: 'Alex iPhone', deviceType: 'iphone', status: 'connected' },
      { phoneId: 'phone-2', label: 'Phone 2', deviceType: 'phone', status: 'reconnecting' },
    ] });
    const phoneRows = elements.get('paired-phones').children;
    assert.equal(phoneRows.length, 2);
    assert.equal(elements.get('paired-phone-count').textContent, '2 / 8');
    assert.equal(phoneRows[0].children[0].children[0].textContent, 'Alex iPhone');
    assert.equal(phoneRows[0].children[1].textContent, 'Connected');
    assert.equal(phoneRows[1].children[1].textContent, 'Reconnecting');
    await phoneRows[0].children[2].dispatch('click');
    assert.deepEqual(socket.sent.at(-1), { type: 'removePhone', phoneId: 'phone-1' });
    socket.message({ type: 'inviteExpired' });
    assert.equal(elements.get('new-pairing-link').hidden, false);
    assert.equal(elements.get('pairing-qr-panel').hidden, true);
    await elements.get('new-pairing-link').dispatch('click');
    assert.ok(calls.some(({ url, body }) => url === '/api/mobile-remote/renew-invite' && body && Object.keys(body).length === 0));
    assert.equal(elements.get('pairing-qr').src, 'data:image/png;base64,renewed');
    assert.equal(elements.get('pairing-url').value, 'http://192.168.1.20:43123/remote#renewed');
    assert.equal(elements.get('pairing-qr-panel').hidden, false);
    assert.equal(elements.get('pairing-url-panel').hidden, false);

    socket.message({ type: 'phonePaired' });
    assert.match(elements.get('pairing-status').textContent, /Phone connected/);
    await elements.get('disconnect-phone').dispatch('click');
    assert.ok(calls.some(({ url, body }) => url === '/api/mobile-remote/stop' && body && Object.keys(body).length === 0));
    assert.equal(socket.readyState, 3);
    assert.equal(elements.get('pairing-status').textContent, 'Disconnected');
    assert.equal(elements.get('pairing-qr-panel').hidden, true);
    assert.equal(elements.get('pairing-url-panel').hidden, true);
    assert.equal(elements.get('pairing-url').value, '');
    assert.equal(elements.get('new-pairing-link').hidden, true);
    assert.equal(elements.get('disconnect-phone').hidden, true);
    assert.equal(cameraRequests, 0);

    const rejectionCases = [
      {
        event: { type: 'presenterRejected', reason: 'invalid-credential' },
        status: 'The presenter session could not be verified (`invalid-credential`). Disconnect all, then create a new session.',
      },
      {
        event: { type: 'presenterRejected', reason: 'already-connected' },
        status: 'The presenter session was rejected as already in use (`already-connected`). Disconnect all, then create a new session.',
      },
      {
        event: { type: 'presenterRejected', reason: 'session-missing' },
        status: 'The presenter session could not be found (`session-missing`). Disconnect all, then create a new session.',
      },
      {
        event: { type: 'presenterRejected', reason: 'session-ended' },
        status: 'The presenter session has ended (`session-ended`). Disconnect all, then create a new session.',
      },
      {
        event: { type: 'presenterRejected', reason: 'invalid-session-state' },
        status: 'The presenter session state could not be read (`invalid-session-state`). Disconnect all, then create a new session.',
      },
      {
        event: { type: 'presenterRejected', reason: 'untrusted invite secret' },
        status: 'The presenter connection was rejected. Disconnect all, then create a new session.',
      },
      {
        event: { type: 'presenterRejected' },
        status: 'The presenter connection was rejected. Disconnect all, then create a new session.',
      },
    ];
    for (const { event, status } of rejectionCases) {
      await elements.get('start-phone-remote').dispatch('click');
      const rejectionSocket = RemoteSocket.instance;
      rejectionSocket.open();
      rejectionSocket.message(event);
      assert.equal(elements.get('pairing-status').textContent, status);
      assert.equal(elements.get('disconnect-phone').hidden, false);
      assert.equal(elements.get('start-phone-remote').disabled, true);
      const stopCount = calls.filter(({ url }) => url === '/api/mobile-remote/stop').length;
      rejectionSocket.close();
      assert.equal(elements.get('pairing-status').textContent, status);
      assert.equal(calls.filter(({ url }) => url === '/api/mobile-remote/stop').length, stopCount);
      await elements.get('disconnect-phone').dispatch('click');
      assert.equal(elements.get('pairing-status').textContent, 'Disconnected');
      assert.equal(calls.filter(({ url }) => url === '/api/mobile-remote/stop').length, stopCount + 1);
    }

    await elements.get('close-pairing-dialog').dispatch('click');
    assert.equal(elements.get('pairing-dialog').open, false);
    assert.equal(fakeDocument.activeElement, connectButton);
    connectButton.focus();
    await connectButton.dispatch('click');
    elements.get('pairing-interface').value = '10.0.0.4';
    elements.get('pairing-interface').dispatch('change');
    publishExtensionState({ connected: true, ready: true });
    assert.equal(elements.get('target-status').textContent, 'Canva presentation · Connected');
    await connectButton.dispatch('click');
    elements.get('pairing-interface').value = '192.168.1.20';
    elements.get('pairing-interface').dispatch('change');
    await elements.get('start-phone-remote').dispatch('click');
    const canvaStartCall = calls.filter(({ url }) => url === '/api/mobile-remote/start').at(-1);
    assert.deepEqual(canvaStartCall.body, {
      address: '192.168.1.20',
      state: { target: 'canva', ready: true, index: null, total: null, busy: false },
    });
    const canvaSocket = RemoteSocket.instance;
    canvaSocket.open();
    canvaSocket.message({ type: 'presenterReady' });
    canvaSocket.message({ type: 'command', id: 'canva-next', action: 'next' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(extensionRequests.at(-1).action, 'next');
    assert.equal(elements.get('slide-number').textContent, '01');
    assert.deepEqual(canvaSocket.sent.at(-1), { type: 'commandAck', id: 'canva-next', accepted: true });

    publishExtensionState({ connected: false, ready: false });
    assert.equal(elements.get('target-status').textContent, 'Canva presentation · Disconnected');
    canvaSocket.message({ type: 'command', id: 'canva-offline', action: 'next' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(canvaSocket.sent.at(-1), { type: 'commandAck', id: 'canva-offline', accepted: false });

    const pagehideSocket = canvaSocket;
    const stopsBeforePagehide = calls.filter(({ url }) => url === '/api/mobile-remote/stop').length;
    await windowListeners.get('pagehide')?.[0]?.();
    assert.equal(calls.filter(({ url }) => url === '/api/mobile-remote/stop').length, stopsBeforePagehide + 1);
    assert.equal(pagehideSocket.readyState, 3);
    assert.equal(elements.get('pairing-url').value, '');
    assert.equal(elements.get('pairing-status').textContent, 'Disconnected');
    assert.equal(cameraRequests, 0);
  } finally {
    harness.restore();
  }
});

test('hosted Canva pairing starts before controls are ready and publishes readiness changes', async () => {
  const harness = await createPairingHarness({
    pageUrl: 'https://gesturedeck-two.vercel.app/workspace.html?experience=cloud&connect=phone',
    initialExtensionState: { connected: true, ready: false },
  });
  const { elements, extensionRequests, publishExtensionState, calls, RemoteSocket } = harness;
  try {
    await new Promise((resolve) => setImmediate(resolve));

    const startCall = calls.find(({ url }) => url === '/api/cloud-remote/start');
    assert.ok(startCall, 'a connected Canva tab can create a hosted phone session before controls appear');
    assert.equal(startCall.options.method, 'POST');
    assert.deepEqual(startCall.body, {
      state: { target: 'canva', ready: false, index: null, total: null, busy: false },
    });
    assert.equal(elements.get('pairing-dialog').open, true);

    const socket = RemoteSocket.instance;
    assert.ok(socket, 'the hosted presenter socket is created');
    socket.open();
    socket.message({ type: 'presenterReady' });
    assert.deepEqual(socket.sent.at(-1), {
      type: 'state', target: 'canva', ready: false, index: null, total: null, busy: false,
    });

    socket.message({ type: 'command', id: 'not-ready-next', action: 'next' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(extensionRequests.filter(({ command }) => command === 'navigate').length, 0);
    assert.deepEqual(socket.sent.at(-1), { type: 'commandAck', id: 'not-ready-next', accepted: false });

    const navigateRequestsBeforePrevious = extensionRequests.filter(({ command }) => command === 'navigate').length;
    socket.message({ type: 'command', id: 'not-ready-previous', action: 'previous' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(extensionRequests.filter(({ command }) => command === 'navigate').length, navigateRequestsBeforePrevious);
    assert.deepEqual(socket.sent.at(-1), { type: 'commandAck', id: 'not-ready-previous', accepted: false });

    publishExtensionState({ connected: true, ready: true });
    assert.deepEqual(socket.sent.at(-1), {
      type: 'state', target: 'canva', ready: true, index: null, total: null, busy: false,
    });

    const statesBeforeDisconnect = socket.sent.filter(({ type }) => type === 'state').length;
    publishExtensionState({ connected: false, ready: false });
    const statesAfterDisconnect = socket.sent.filter(({ type }) => type === 'state');
    assert.equal(statesAfterDisconnect.length, statesBeforeDisconnect + 1);
    assert.deepEqual(statesAfterDisconnect.at(-1), {
      type: 'state', target: 'canva', ready: false, index: null, total: null, busy: false,
    });
    publishExtensionState({ connected: false, ready: false });
    assert.equal(socket.sent.filter(({ type }) => type === 'state').length, statesAfterDisconnect.length);
  } finally {
    harness.restore();
  }
});

test('hosted startup with Canva disconnected opens pairing without starting a session', async () => {
  const harness = await createPairingHarness({
    pageUrl: 'https://gesturedeck-two.vercel.app/workspace.html?experience=cloud&connect=phone',
    initialExtensionState: { connected: false, ready: false },
  });
  const { elements, calls } = harness;
  try {
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(elements.get('pairing-dialog').open, true);
    assert.equal(elements.get('pairing-status').textContent,
      'Connect Canva in the extension first, then open phone pairing again.');
    assert.equal(calls.some(({ url }) => url === '/api/cloud-remote/start'), false);
  } finally {
    harness.restore();
  }
});

test('hosted presenter reconnects without replacing its pairing session and Stop remains terminal', async () => {
  const harness = await createPairingHarness({
    pageUrl: 'https://gesturedeck-two.vercel.app/workspace.html?experience=cloud&connect=phone',
    initialExtensionState: { connected: true, ready: true },
  });
  const { elements, calls, remoteSockets } = harness;
  try {
    await new Promise((resolve) => setImmediate(resolve));
    const firstSocket = remoteSockets[0];
    firstSocket.open();
    firstSocket.message({ type: 'presenterReady' });
    firstSocket.message({ type: 'phones', phones: [
      { phoneId: 'phone-1', label: 'Alex iPhone', deviceType: 'iphone', status: 'connected' },
    ] });
    firstSocket.close();

    assert.equal(calls.some(({ url }) => url === '/api/cloud-remote/stop'), false);
    assert.equal(elements.get('pairing-qr-panel').hidden, false);
    assert.equal(elements.get('pairing-url-panel').hidden, false);
    assert.equal(elements.get('pairing-url').value,
      'https://gesturedeck-two.vercel.app/r/abcdefghijklmnop#invite-secret');
    assert.equal(elements.get('paired-phones').children.length, 1);
    assert.equal(elements.get('disconnect-phone').hidden, false);
    assert.match(elements.get('pairing-status').textContent, /Reconnecting/);

    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(remoteSockets.length, 2);
    const recovered = remoteSockets[1];
    assert.match(recovered.url, /session=abcdefghijklmnop/);
    recovered.open();
    assert.deepEqual(recovered.sent[0], { type: 'presenter', credential: 'host-secret' });
    recovered.message({ type: 'presenterReady' });
    assert.deepEqual(recovered.sent.at(-1), {
      type: 'state', target: 'canva', ready: true, index: null, total: null, busy: false,
    });
    assert.equal(elements.get('pairing-qr-panel').hidden, false);
    assert.equal(elements.get('paired-phones').children.length, 1);

    await elements.get('disconnect-phone').dispatch('click');
    assert.equal(recovered.readyState, 3);
    assert.equal(calls.filter(({ url }) => url === '/api/cloud-remote/stop').length, 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(remoteSockets.length, 2, 'explicit Stop cancels automatic retries');
  } finally {
    harness.restore();
  }
});

test('hosted pagehide stops the session and cancels a pending reconnect', async () => {
  const harness = await createPairingHarness({
    pageUrl: 'https://gesturedeck-two.vercel.app/workspace.html?experience=cloud&connect=phone',
    initialExtensionState: { connected: true, ready: true },
  });
  const { calls, remoteSockets, windowListeners } = harness;
  try {
    await new Promise((resolve) => setImmediate(resolve));
    const socket = remoteSockets[0];
    socket.open();
    socket.message({ type: 'presenterReady' });
    socket.close();

    await windowListeners.get('pagehide')?.[0]?.();
    const stop = calls.find(({ url }) => url === '/api/cloud-remote/stop');
    assert.ok(stop);
    assert.equal(stop.options.keepalive, true);
    assert.deepEqual(stop.body, { sessionId: 'abcdefghijklmnop', hostCredential: 'host-secret' });
    assert.equal(socket.readyState, 3);

    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(remoteSockets.length, 1, 'pagehide cancels the scheduled retry');
  } finally {
    harness.restore();
  }
});
