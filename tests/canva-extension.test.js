import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import {
  isCanvaUrl,
  isCanvaPresentationUrl,
  isControllerRequest,
  isLoopbackControllerUrl,
  presentationKeyForAction,
} from '../extension/shared/protocol.js';
import { createCanvaExtensionBridge } from '../extension/shared/page-bridge.js';
import { createCanvaExtensionWorker } from '../extension/background/service-worker.js';

class FakeWindow {
  constructor(origin = 'http://127.0.0.1:5173') {
    this.location = { origin };
    this.sent = [];
    this.listeners = new Map();
  }

  addEventListener(type, callback) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(callback);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  postMessage(data, targetOrigin) { this.sent.push({ data, targetOrigin }); }

  dispatchMessage(data, { source = this, origin = this.location.origin } = {}) {
    for (const callback of this.listeners.get('message') ?? []) callback({ source, origin, data });
  }
}

class FakeEvent {
  listeners = [];
  addListener(callback) { this.listeners.push(callback); }
  fire(...args) { return this.listeners.map((callback) => callback(...args)); }
}

class FakePort {
  constructor(name, sender) {
    this.name = name;
    this.sender = sender;
    this.sent = [];
    this.onMessage = new FakeEvent();
    this.onDisconnect = new FakeEvent();
  }
  postMessage(message) { this.sent.push(message); }
  disconnect() { this.disconnected = true; this.onDisconnect.fire(); }
}

function fakeChrome(activeTabUrl) {
  const storage = {};
  const injections = [];
  const debuggerCalls = [];
  let debuggerFailure;
  const tab = { id: 7, url: activeTabUrl };
  const tabsById = new Map([[tab.id, tab]]);
  let activeTab = tab;
  let probeReadyOverride;
  const chromeApi = {
    runtime: {
      id: 'extension-id',
      onConnect: new FakeEvent(),
      onMessage: new FakeEvent(),
      getURL: (path) => `chrome-extension://extension-id/${path}`,
    },
    storage: { session: {
      async get(key) { return { [key]: storage[key] }; },
      async set(value) { Object.assign(storage, value); },
      async remove(key) { delete storage[key]; },
    } },
    tabs: {
      onUpdated: new FakeEvent(),
      onRemoved: new FakeEvent(),
      async query() { return [activeTab]; },
      async get(tabId) {
        const selected = tabsById.get(tabId);
        if (!selected) throw new Error('missing tab');
        return selected;
      },
      async sendMessage(tabId, message) {
        const selected = tabsById.get(tabId);
        if (!selected) throw new Error('missing tab');
        if (message.type === 'probe') return {
          ready: probeReadyOverride ?? isCanvaPresentationUrl(selected.url),
        };
        return undefined;
      },
    },
    scripting: { async executeScript(details) { injections.push(details); } },
    debugger: {
      async attach(target, version) {
        debuggerCalls.push({ operation: 'attach', target, version });
        if (debuggerFailure?.operation === 'attach') throw new Error('debugger attach failed');
      },
      async sendCommand(target, method, params) {
        debuggerCalls.push({ operation: 'sendCommand', target, method, params });
        if (debuggerFailure?.operation === 'sendCommand'
          && debuggerFailure.type === params.type) throw new Error('debugger command failed');
      },
      async detach(target) { debuggerCalls.push({ operation: 'detach', target }); },
    },
  };
  return {
    chromeApi, storage, injections, debuggerCalls, tab, tabsById,
    setProbeReady(ready) { probeReadyOverride = ready; },
    failDebugger(failure) { debuggerFailure = failure; },
    setActiveTab(selected) {
      tabsById.set(selected.id, selected);
      activeTab = selected;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function sendExtensionMessage(chromeApi, message) {
  const listener = chromeApi.runtime.onMessage.listeners[0];
  return new Promise((resolve) => {
    listener(message, {
      id: chromeApi.runtime.id,
      url: chromeApi.runtime.getURL('popup/popup.html'),
    }, resolve);
  });
}

async function connectToPopupTab(chromeApi, tabId) {
  return sendExtensionMessage(chromeApi, { type: 'popup-connect', tabId });
}

async function connectToActivePopupTab(chromeApi) {
  const [tab] = await chromeApi.tabs.query({ active: true, lastFocusedWindow: true });
  return connectToPopupTab(chromeApi, tab?.id);
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('expected the extension worker to answer');
}

async function createPopupHarness({ createTab } = {}) {
  const source = await readFile(new URL('../extension/popup/popup.js', import.meta.url), 'utf8');
  const markup = await readFile(new URL('../extension/popup/popup.html', import.meta.url), 'utf8');
  const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => id);
  const elements = new Map(ids.map((id) => [id, {
    hidden: false,
    textContent: '',
    listeners: new Map(),
    addEventListener(type, callback) { this.listeners.set(type, callback); },
  }]));
  const requests = [];
  const openedTabs = [];
  const context = {
    document: { getElementById: (id) => elements.get(id) },
    chrome: {
      tabs: {
        async query() { return [{ id: 7 }]; },
        async create({ url }) {
          if (createTab) return createTab({ url });
          openedTabs.push(url);
        },
      },
      runtime: {
        sendMessage(message) {
          const response = deferred();
          requests.push({ message, ...response });
          return response.promise;
        },
      },
    },
  };
  context.globalThis = context;
  runInNewContext(source, context);
  return { elements, requests, openedTabs };
}

test('extension protocol allows only loopback controller pages and Canva navigation', () => {
  assert.equal(isLoopbackControllerUrl('http://127.0.0.1:5173/'), true);
  assert.equal(isLoopbackControllerUrl('http://localhost:5173/'), true);
  assert.equal(isLoopbackControllerUrl('http://localhost:3000/'), false);
  assert.equal(isLoopbackControllerUrl('http://192.168.1.8:5173/'), false);
  assert.equal(isCanvaUrl('https://www.canva.com/design/example/present'), true);
  assert.equal(isCanvaUrl('https://canva.com/design/example/view'), true);
  assert.equal(isCanvaUrl('https://www.canva.com/design/example/edit'), true);
  assert.equal(isCanvaUrl('https://evil.test/'), false);
  assert.equal(isCanvaPresentationUrl('https://www.canva.com/design/example/present'), true);
  assert.equal(isCanvaPresentationUrl('https://www.canva.com/design/example/view'), true);
  assert.equal(isCanvaPresentationUrl('https://www.canva.com/design/example/edit'), false);
  assert.equal(isControllerRequest({ source: 'gesturedeck', type: 'canva-controller-request', id: 'a', command: 'navigate', action: 'next' }), true);
  assert.equal(isControllerRequest({ source: 'gesturedeck', type: 'canva-controller-request', id: 'a', command: 'navigate', action: 'goTo' }), false);
  assert.equal(isControllerRequest({ source: 'other', type: 'canva-controller-request', id: 'a', command: 'status' }), false);
  assert.equal(isControllerRequest({ source: 'gesturedeck', type: 'canva-controller-request', id: 'bad id', command: 'status' }), false);
  assert.equal(presentationKeyForAction('previous'), 'ArrowLeft');
  assert.equal(presentationKeyForAction('next'), 'ArrowRight');
  assert.equal(presentationKeyForAction('goTo'), null);
});

test('extension permissions stay limited to the selected tab and approved controller origins', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, '0.1.2');
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'debugger', 'scripting', 'storage']);
  assert.deepEqual(manifest.content_scripts[0].matches.sort(), [
    'http://127.0.0.1/*', 'http://localhost/*', 'https://gesturedeck-two.vercel.app/*',
  ]);
  assert.equal(manifest.action.default_popup, 'popup/popup.html');
  assert.equal(manifest.background.service_worker, 'background/service-worker.js');
  assert.deepEqual(manifest.content_scripts[0].js, ['content/controller-bridge.js']);
  assert.equal('host_permissions' in manifest, false);

  for (const entrypoint of [
    manifest.action.default_popup,
    manifest.background.service_worker,
    ...manifest.content_scripts.flatMap(({ js }) => js),
  ]) {
    await assert.doesNotReject(readFile(new URL(`../extension/${entrypoint}`, import.meta.url)));
  }
});

test('popup includes the active tab ID in its Connect request', async () => {
  const popup = await createPopupHarness();
  popup.elements.get('connect').listeners.get('click')();
  await waitFor(() => popup.requests.some(({ message }) => message.type === 'popup-connect'));

  const request = popup.requests.find(({ message }) => message.type === 'popup-connect').message;
  assert.equal(request.tabId, 7);
  assert.deepEqual(Object.keys(request).sort(), ['tabId', 'type']);
  for (const pending of popup.requests) pending.resolve({ connected: false, ready: false });
});

test('popup opens hosted phone pairing for a connected Canva presentation before it is ready', async () => {
  const popup = await createPopupHarness();
  const pairingButton = popup.elements.get('show-phone-pairing');
  const pairingHint = popup.elements.get('phone-pairing-hint');
  const pairingUrl = 'https://gesturedeck-two.vercel.app/workspace.html?experience=cloud&connect=phone';

  popup.requests.find(({ message }) => message.type === 'popup-status')
    .resolve({ connected: true, ready: false });
  await waitFor(() => popup.elements.get('status').textContent
    === 'Canva tab connected. Start Present to enable phone navigation.');
  assert.equal(pairingButton.disabled, false);
  assert.equal(pairingHint.hidden, false);
  assert.equal(pairingHint.textContent, 'Canva tab connected. Start Present to enable phone navigation.');
  pairingButton.listeners.get('click')();
  await waitFor(() => popup.openedTabs.length === 1);
  assert.deepEqual(popup.openedTabs, [pairingUrl]);

  popup.elements.get('connect').listeners.get('click')();
  await waitFor(() => popup.requests.some(({ message }) => message.type === 'popup-connect'));
  popup.requests.find(({ message }) => message.type === 'popup-connect')
    .resolve({ connected: true, ready: true });
  await waitFor(() => popup.elements.get('status').textContent === 'Canva presentation connected.');
  assert.equal(pairingButton.disabled, false);
  assert.equal(pairingHint.hidden, true);

  pairingButton.listeners.get('click')();
  await waitFor(() => popup.openedTabs.length === 2);
  assert.deepEqual(popup.openedTabs, [pairingUrl, pairingUrl]);
});

test('popup keeps hosted phone pairing disabled while Canva is disconnected', async () => {
  const popup = await createPopupHarness();
  const pairingButton = popup.elements.get('show-phone-pairing');
  const pairingHint = popup.elements.get('phone-pairing-hint');

  popup.requests.find(({ message }) => message.type === 'popup-status')
    .resolve({ connected: false, ready: false });
  await waitFor(() => popup.elements.get('status').textContent === 'No Canva presentation connected.');

  assert.equal(pairingButton.disabled, true);
  assert.equal(pairingHint.hidden, false);
  assert.equal(pairingHint.textContent, 'Connect a Canva presentation in Present or View mode first.');
});

test('popup shows the expected message when opening hosted phone pairing fails', async () => {
  const popup = await createPopupHarness({
    async createTab() { throw new Error('tab creation failed'); },
  });
  const pairingButton = popup.elements.get('show-phone-pairing');

  popup.requests.find(({ message }) => message.type === 'popup-status')
    .resolve({ connected: true, ready: true });
  await waitFor(() => pairingButton.disabled === false);

  pairingButton.listeners.get('click')();
  await waitFor(() => popup.elements.get('status').textContent
    === 'Could not open the hosted phone pairing page. Try again.');
});

test('popup ignores an older status response after a Connect request succeeds', async () => {
  const popup = await createPopupHarness();
  popup.elements.get('connect').listeners.get('click')();
  await waitFor(() => popup.requests.some(({ message }) => message.type === 'popup-connect'));

  popup.requests.find(({ message }) => message.type === 'popup-connect')
    .resolve({ connected: true, ready: true });
  await waitFor(() => popup.elements.get('status').textContent === 'Canva presentation connected.');
  popup.requests.find(({ message }) => message.type === 'popup-status')
    .resolve({ connected: false, ready: false });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(popup.elements.get('status').textContent, 'Canva presentation connected.');
});

test('popup keeps Connect available while a Canva presentation is ready', async () => {
  const popup = await createPopupHarness();
  popup.requests.find(({ message }) => message.type === 'popup-status')
    .resolve({ connected: true, ready: true });
  await waitFor(() => popup.elements.get('status').textContent === 'Canva presentation connected.');

  assert.equal(popup.elements.get('connect').hidden, false);
  assert.equal(popup.elements.get('disconnect').hidden, false);
});

test('extension bridge resolves status and navigation responses by request ID', async () => {
  const windowImpl = new FakeWindow();
  let id = 0;
  const bridge = createCanvaExtensionBridge({
    windowImpl,
    timeoutMs: 100,
    createRequestId: () => `request-${++id}`,
  });
  const statusRequest = bridge.requestStatus();
  assert.deepEqual(windowImpl.sent.at(-1), {
    targetOrigin: windowImpl.location.origin,
    data: {
      source: 'gesturedeck', type: 'canva-controller-request',
      id: 'request-1', command: 'status',
    },
  });
  windowImpl.dispatchMessage({
    source: 'gesturedeck-extension', type: 'canva-controller-response', id: 'request-1',
    command: 'status', state: { connected: true, ready: true },
  });
  assert.deepEqual(await statusRequest, { connected: true, ready: true });

  const navigation = bridge.sendNavigation('previous');
  assert.deepEqual(windowImpl.sent.at(-1).data, {
    source: 'gesturedeck', type: 'canva-controller-request',
    id: 'request-2', command: 'navigate', action: 'previous',
  });
  windowImpl.dispatchMessage({
    source: 'gesturedeck-extension', type: 'canva-controller-response', id: 'request-2',
    command: 'navigate', accepted: true,
  });
  assert.equal(await navigation, true);
  assert.equal(await bridge.sendNavigation('goTo'), false);
  bridge.close();
});

test('extension bridge ignores foreign message sources and reports timeout as disconnected', async () => {
  const windowImpl = new FakeWindow();
  const bridge = createCanvaExtensionBridge({
    windowImpl, timeoutMs: 5, createRequestId: () => 'request-1',
  });
  const statusRequest = bridge.requestStatus();
  windowImpl.dispatchMessage({
    source: 'gesturedeck-extension', type: 'canva-controller-response', id: 'request-1',
    command: 'status', state: { connected: true, ready: true },
  }, { source: {} });
  windowImpl.dispatchMessage({
    source: 'gesturedeck-extension', type: 'canva-controller-response', id: 'request-1',
    command: 'status', state: { connected: true, ready: true },
  }, { origin: 'http://evil.test' });
  assert.deepEqual(await statusRequest, { connected: false, ready: false });
  bridge.close();
});

test('extension bridge keeps a newer live target update when an older status response arrives', async () => {
  const windowImpl = new FakeWindow();
  const bridge = createCanvaExtensionBridge({ windowImpl, timeoutMs: 100 });
  const updates = [];
  bridge.subscribe((state) => updates.push(state));
  const statusRequest = bridge.requestStatus();
  const requestId = windowImpl.sent.at(-1).data.id;

  windowImpl.dispatchMessage({
    source: 'gesturedeck-extension', type: 'canva-target-state', connected: true, ready: true,
  });
  windowImpl.dispatchMessage({
    source: 'gesturedeck-extension', type: 'canva-controller-response', id: requestId,
    command: 'status', state: { connected: false, ready: false },
  });

  assert.deepEqual(await statusRequest, { connected: true, ready: true });
  assert.deepEqual(updates, [{ connected: true, ready: true }]);
  bridge.close();
});

test('extension bridge drops stale readiness when status or navigation requests time out', async () => {
  const windowImpl = new FakeWindow();
  const bridge = createCanvaExtensionBridge({ windowImpl, timeoutMs: 5 });
  const updates = [];
  bridge.subscribe((state) => updates.push(state));
  windowImpl.dispatchMessage({
    source: 'gesturedeck-extension', type: 'canva-target-state', connected: true, ready: true,
  });

  assert.deepEqual(await bridge.requestStatus(), { connected: false, ready: false });
  windowImpl.dispatchMessage({
    source: 'gesturedeck-extension', type: 'canva-target-state', connected: true, ready: true,
  });
  assert.equal(await bridge.sendNavigation('next'), false);
  assert.deepEqual(updates, [
    { connected: true, ready: true },
    { connected: false, ready: false },
    { connected: true, ready: true },
    { connected: false, ready: false },
  ]);
  bridge.close();
});

test('extension dispatches phone navigation keys through Chrome debugger on the selected tab', async () => {
  const fake = fakeChrome('https://www.canva.com/design/deck-1/present');
  createCanvaExtensionWorker(fake.chromeApi);
  assert.deepEqual(await connectToActivePopupTab(fake.chromeApi), {
    connected: true, ready: true,
  });
  assert.deepEqual(fake.injections, [{ target: { tabId: 7 }, files: ['content/canva-content.js'] }]);

  const port = new FakePort('controller', { url: 'http://127.0.0.1:5173/' });
  fake.chromeApi.runtime.onConnect.fire(port);
  await new Promise((resolve) => setImmediate(resolve));
  port.onMessage.fire({
    source: 'gesturedeck', type: 'canva-controller-request', id: 'next-1',
    command: 'navigate', action: 'next',
  });
  await waitFor(() => port.sent.some((message) => message.id === 'next-1'));
  assert.deepEqual(fake.debuggerCalls, [
    { operation: 'attach', target: { tabId: 7 }, version: '1.3' },
    {
      operation: 'sendCommand', target: { tabId: 7 }, method: 'Input.dispatchKeyEvent',
      params: { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
    },
    {
      operation: 'sendCommand', target: { tabId: 7 }, method: 'Input.dispatchKeyEvent',
      params: { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
    },
    { operation: 'detach', target: { tabId: 7 } },
  ]);
  assert.deepEqual(port.sent.find((message) => message.id === 'next-1'), {
    source: 'gesturedeck-extension', type: 'canva-controller-response',
    id: 'next-1', command: 'navigate', accepted: true,
  });

  port.onMessage.fire({
    source: 'gesturedeck', type: 'canva-controller-request', id: 'previous-1',
    command: 'navigate', action: 'previous',
  });
  await waitFor(() => port.sent.some((message) => message.id === 'previous-1'));
  assert.deepEqual(fake.debuggerCalls.slice(4), [
    { operation: 'attach', target: { tabId: 7 }, version: '1.3' },
    {
      operation: 'sendCommand', target: { tabId: 7 }, method: 'Input.dispatchKeyEvent',
      params: { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
    },
    {
      operation: 'sendCommand', target: { tabId: 7 }, method: 'Input.dispatchKeyEvent',
      params: { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
    },
    { operation: 'detach', target: { tabId: 7 } },
  ]);
  assert.deepEqual(port.sent.find((message) => message.id === 'previous-1'), {
    source: 'gesturedeck-extension', type: 'canva-controller-response',
    id: 'previous-1', command: 'navigate', accepted: true,
  });
});

test('extension rejects navigation when Chrome debugger cannot attach', async () => {
  const fake = fakeChrome('https://www.canva.com/design/deck-1/present');
  createCanvaExtensionWorker(fake.chromeApi);
  await connectToActivePopupTab(fake.chromeApi);
  const port = new FakePort('controller', { url: 'http://127.0.0.1:5173/' });
  fake.chromeApi.runtime.onConnect.fire(port);
  await waitFor(() => port.sent.some((message) => message.type === 'canva-target-state'));
  fake.failDebugger({ operation: 'attach' });

  port.onMessage.fire({
    source: 'gesturedeck', type: 'canva-controller-request', id: 'attach-failed',
    command: 'navigate', action: 'next',
  });
  await waitFor(() => port.sent.some((message) => message.id === 'attach-failed'));

  assert.deepEqual(fake.debuggerCalls, [
    { operation: 'attach', target: { tabId: 7 }, version: '1.3' },
  ]);
  assert.deepEqual(port.sent.find((message) => message.id === 'attach-failed'), {
    source: 'gesturedeck-extension', type: 'canva-controller-response',
    id: 'attach-failed', command: 'navigate', accepted: false,
  });
});

test('extension serializes overlapping navigation commands for one Canva tab', async () => {
  const fake = fakeChrome('https://www.canva.com/design/deck-1/present');
  createCanvaExtensionWorker(fake.chromeApi);
  await connectToActivePopupTab(fake.chromeApi);
  const port = new FakePort('controller', { url: 'http://127.0.0.1:5173/' });
  fake.chromeApi.runtime.onConnect.fire(port);
  await waitFor(() => port.sent.some((message) => message.type === 'canva-target-state'));

  const firstAttachGate = deferred();
  const attach = fake.chromeApi.debugger.attach.bind(fake.chromeApi.debugger);
  let attachCount = 0;
  let maxConcurrentAttaches = 0;
  fake.chromeApi.debugger.attach = async (...args) => {
    attachCount += 1;
    maxConcurrentAttaches = Math.max(maxConcurrentAttaches, attachCount);
    try {
      await firstAttachGate.promise;
      await attach(...args);
    } finally {
      attachCount -= 1;
    }
  };
  port.onMessage.fire({
    source: 'gesturedeck', type: 'canva-controller-request', id: 'overlap-next',
    command: 'navigate', action: 'next',
  });
  port.onMessage.fire({
    source: 'gesturedeck', type: 'canva-controller-request', id: 'overlap-previous',
    command: 'navigate', action: 'previous',
  });
  await waitFor(() => maxConcurrentAttaches > 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maxConcurrentAttaches, 1);

  firstAttachGate.resolve();
  await waitFor(() => port.sent.some((message) => message.id === 'overlap-next')
    && port.sent.some((message) => message.id === 'overlap-previous'));
  assert.equal(maxConcurrentAttaches, 1);
  assert.deepEqual(fake.debuggerCalls.filter(({ operation, params }) => (
    operation === 'sendCommand' && params.type === 'keyDown'
  )).map(({ params }) => params.key), ['ArrowRight', 'ArrowLeft']);
  assert.equal(fake.debuggerCalls.filter(({ operation }) => operation === 'attach').length, 2);
  assert.equal(fake.debuggerCalls.filter(({ operation }) => operation === 'detach').length, 2);
  assert.equal(port.sent.find((message) => message.id === 'overlap-next').accepted, true);
  assert.equal(port.sent.find((message) => message.id === 'overlap-previous').accepted, true);
});

test('queued Canva navigation rechecks readiness before and after debugger attach', async () => {
  const fake = fakeChrome('https://www.canva.com/design/deck-1/present');
  createCanvaExtensionWorker(fake.chromeApi);
  await connectToActivePopupTab(fake.chromeApi);
  const port = new FakePort('controller', { url: 'http://127.0.0.1:5173/' });
  fake.chromeApi.runtime.onConnect.fire(port);
  await waitFor(() => port.sent.some((message) => message.type === 'canva-target-state'));

  const attachGate = deferred();
  const attachStarted = deferred();
  const attach = fake.chromeApi.debugger.attach.bind(fake.chromeApi.debugger);
  fake.chromeApi.debugger.attach = async (...args) => {
    attachStarted.resolve();
    await attachGate.promise;
    await attach(...args);
  };
  const sendMessage = fake.chromeApi.tabs.sendMessage.bind(fake.chromeApi.tabs);
  let probeCount = 0;
  fake.chromeApi.tabs.sendMessage = async (tabId, message) => {
    if (message.type === 'probe') probeCount += 1;
    return sendMessage(tabId, message);
  };

  port.onMessage.fire({
    source: 'gesturedeck', type: 'canva-controller-request', id: 'queued-next',
    command: 'navigate', action: 'next',
  });
  await attachStarted.promise;

  const secondRequestProbeCount = probeCount;
  port.onMessage.fire({
    source: 'gesturedeck', type: 'canva-controller-request', id: 'queued-previous',
    command: 'navigate', action: 'previous',
  });
  await waitFor(() => probeCount > secondRequestProbeCount);
  await new Promise((resolve) => setImmediate(resolve));
  fake.setProbeReady(false);
  attachGate.resolve();

  await waitFor(() => port.sent.some((message) => message.id === 'queued-next')
    && port.sent.some((message) => message.id === 'queued-previous'));
  assert.equal(port.sent.find((message) => message.id === 'queued-next').accepted, false);
  assert.equal(port.sent.find((message) => message.id === 'queued-previous').accepted, false);
  assert.deepEqual(fake.debuggerCalls.map(({ operation, params }) => [operation, params?.type]), [
    ['attach', undefined], ['detach', undefined],
  ]);
});

test('extension rejects navigation when key release fails and still detaches debugger', async () => {
  const fake = fakeChrome('https://www.canva.com/design/deck-1/present');
  createCanvaExtensionWorker(fake.chromeApi);
  await connectToActivePopupTab(fake.chromeApi);
  const port = new FakePort('controller', { url: 'http://127.0.0.1:5173/' });
  fake.chromeApi.runtime.onConnect.fire(port);
  await waitFor(() => port.sent.some((message) => message.type === 'canva-target-state'));
  fake.failDebugger({ operation: 'sendCommand', type: 'keyUp' });

  port.onMessage.fire({
    source: 'gesturedeck', type: 'canva-controller-request', id: 'failed-key-up',
    command: 'navigate', action: 'previous',
  });
  await waitFor(() => port.sent.some((message) => message.id === 'failed-key-up'));

  assert.deepEqual(fake.debuggerCalls.map(({ operation, params }) => [operation, params?.type]), [
    ['attach', undefined], ['sendCommand', 'keyDown'], ['sendCommand', 'keyUp'],
    ['sendCommand', 'keyUp'], ['detach', undefined],
  ]);
  assert.deepEqual(port.sent.find((message) => message.id === 'failed-key-up'), {
    source: 'gesturedeck-extension', type: 'canva-controller-response',
    id: 'failed-key-up', command: 'navigate', accepted: false,
  });
});

test('extension connects to a supported Canva tab before navigation controls appear', async () => {
  const fake = fakeChrome('https://www.canva.com/design/deck-1/view');
  fake.setProbeReady(false);
  createCanvaExtensionWorker(fake.chromeApi);

  assert.deepEqual(await connectToActivePopupTab(fake.chromeApi), {
    connected: true, ready: false,
  });
  assert.equal(fake.storage.canvaTabId, 7);
  assert.deepEqual(fake.injections, [{ target: { tabId: 7 }, files: ['content/canva-content.js'] }]);

  const port = new FakePort('controller', { url: 'http://127.0.0.1:5173/' });
  fake.chromeApi.runtime.onConnect.fire(port);
  await waitFor(() => port.sent.some((message) => message.type === 'canva-target-state'
    && message.connected === true && message.ready === false));

  port.onMessage.fire({
    source: 'gesturedeck', type: 'canva-controller-request', id: 'not-ready-next',
    command: 'navigate', action: 'next',
  });
  await waitFor(() => port.sent.some((message) => message.id === 'not-ready-next'));
  assert.deepEqual(port.sent.find((message) => message.id === 'not-ready-next'), {
    source: 'gesturedeck-extension', type: 'canva-controller-response',
    id: 'not-ready-next', command: 'navigate', accepted: false,
  });
  assert.equal(fake.debuggerCalls.length, 0, 'navigation must wait until Canva controls are ready');

  fake.setProbeReady(true);
  fake.chromeApi.runtime.onMessage.listeners[0]({ type: 'target-readiness', ready: true }, {
    id: fake.chromeApi.runtime.id,
    tab: { id: 7 },
  }, () => {});
  await waitFor(() => port.sent.some((message) => message.type === 'canva-target-state'
    && message.connected === true && message.ready === true));

  port.onMessage.fire({
    source: 'gesturedeck', type: 'canva-controller-request', id: 'ready-next',
    command: 'navigate', action: 'next',
  });
  await waitFor(() => port.sent.some((message) => message.id === 'ready-next'));
  assert.deepEqual(port.sent.find((message) => message.id === 'ready-next'), {
    source: 'gesturedeck-extension', type: 'canva-controller-response',
    id: 'ready-next', command: 'navigate', accepted: true,
  });
  assert.deepEqual(fake.debuggerCalls.map(({ operation, params }) => [operation, params?.type]), [
    ['attach', undefined], ['sendCommand', 'keyDown'], ['sendCommand', 'keyUp'], ['detach', undefined],
  ]);
});

test('extension connects the tab captured by the popup after the active tab changes', async () => {
  const fake = fakeChrome('https://www.canva.com/design/deck-1/present');
  fake.setActiveTab({ id: 8, url: 'https://www.canva.com/design/deck-2/present' });
  createCanvaExtensionWorker(fake.chromeApi);

  assert.deepEqual(await connectToPopupTab(fake.chromeApi, 7), { connected: true, ready: true });

  assert.deepEqual(fake.injections, [{ target: { tabId: 7 }, files: ['content/canva-content.js'] }]);
});

test('a rejected popup selection leaves the previously connected Canva target active', async () => {
  const fake = fakeChrome('https://www.canva.com/design/deck-1/present');
  createCanvaExtensionWorker(fake.chromeApi);
  await connectToActivePopupTab(fake.chromeApi);

  fake.setActiveTab({ id: 8, url: 'https://www.canva.com/design/deck-2/edit' });
  await connectToActivePopupTab(fake.chromeApi);

  assert.deepEqual(await sendExtensionMessage(fake.chromeApi, { type: 'popup-status' }), {
    connected: true, ready: true,
  });
});

test('extension rejects controller ports from other loopback app ports', () => {
  const fake = fakeChrome('https://www.canva.com/design/deck-1/present');
  createCanvaExtensionWorker(fake.chromeApi);
  const port = new FakePort('controller', { url: 'http://localhost:3000/' });

  fake.chromeApi.runtime.onConnect.fire(port);

  assert.equal(port.disconnected, true);
  assert.equal(port.onMessage.listeners.length, 0);
});

test('extension does not redirect an in-flight command to a newly selected tab', async () => {
  const fake = fakeChrome('https://www.canva.com/design/deck-1/present');
  const nextTab = { id: 8, url: 'https://www.canva.com/design/deck-2/present' };
  createCanvaExtensionWorker(fake.chromeApi);
  await connectToActivePopupTab(fake.chromeApi);

  const port = new FakePort('controller', { url: 'http://127.0.0.1:5173/' });
  fake.chromeApi.runtime.onConnect.fire(port);
  await waitFor(() => port.sent.some((message) => message.type === 'canva-target-state'));

  const delayedTabLookup = deferred();
  const getTab = fake.chromeApi.tabs.get.bind(fake.chromeApi.tabs);
  let lookupStarted = false;
  fake.chromeApi.tabs.get = (tabId) => {
    if (tabId === 7) {
      lookupStarted = true;
      return delayedTabLookup.promise;
    }
    return getTab(tabId);
  };
  port.onMessage.fire({
    source: 'gesturedeck', type: 'canva-controller-request', id: 'old-target-next',
    command: 'navigate', action: 'next',
  });
  await waitFor(() => lookupStarted);

  fake.setActiveTab(nextTab);
  assert.deepEqual(await connectToActivePopupTab(fake.chromeApi), {
    connected: true, ready: true,
  });
  delayedTabLookup.resolve(fake.tab);
  await waitFor(() => port.sent.some((message) => message.id === 'old-target-next'));

  assert.equal(fake.debuggerCalls.length, 0, 'a stale command must stop before debugger attachment');
  assert.deepEqual(port.sent.find((message) => message.id === 'old-target-next'), {
    source: 'gesturedeck-extension', type: 'canva-controller-response',
    id: 'old-target-next', command: 'navigate', accepted: false,
  });
});

test('extension reports navigation rejected when the target changes during key dispatch', async () => {
  const fake = fakeChrome('https://www.canva.com/design/deck-1/present');
  createCanvaExtensionWorker(fake.chromeApi);
  await connectToActivePopupTab(fake.chromeApi);

  const port = new FakePort('controller', { url: 'http://127.0.0.1:5173/' });
  fake.chromeApi.runtime.onConnect.fire(port);
  await waitFor(() => port.sent.some((message) => message.type === 'canva-target-state'));

  const keyUpStarted = deferred();
  const releaseKeyUp = deferred();
  const sendCommand = fake.chromeApi.debugger.sendCommand.bind(fake.chromeApi.debugger);
  fake.chromeApi.debugger.sendCommand = async (target, method, params) => {
    if (params.type === 'keyUp' && target.tabId === 7) {
      keyUpStarted.resolve();
      await releaseKeyUp.promise;
    }
    return sendCommand(target, method, params);
  };

  port.onMessage.fire({
    source: 'gesturedeck', type: 'canva-controller-request', id: 'target-changed-during-dispatch',
    command: 'navigate', action: 'next',
  });
  await keyUpStarted.promise;

  const nextTab = { id: 8, url: 'https://www.canva.com/design/deck-2/present' };
  fake.setActiveTab(nextTab);
  assert.deepEqual(await connectToPopupTab(fake.chromeApi, nextTab.id), { connected: true, ready: true });
  releaseKeyUp.resolve();
  await waitFor(() => port.sent.some((message) => message.id === 'target-changed-during-dispatch'));

  assert.equal(fake.debuggerCalls.some(({ target }) => target.tabId === 8), false);
  assert.equal(fake.debuggerCalls.some(({ operation, target }) => (
    operation === 'detach' && target.tabId === 7
  )), true);
  assert.deepEqual(port.sent.find((message) => message.id === 'target-changed-during-dispatch'), {
    source: 'gesturedeck-extension', type: 'canva-controller-response',
    id: 'target-changed-during-dispatch', command: 'navigate', accepted: false,
  });
});

test('a delayed failure reading an old target cannot clear a newly selected tab', async () => {
  const fake = fakeChrome('https://www.canva.com/design/deck-1/present');
  const nextTab = { id: 8, url: 'https://www.canva.com/design/deck-2/present' };
  createCanvaExtensionWorker(fake.chromeApi);
  await connectToActivePopupTab(fake.chromeApi);

  const delayedTabLookup = deferred();
  const getTab = fake.chromeApi.tabs.get.bind(fake.chromeApi.tabs);
  let lookupStarted = false;
  fake.chromeApi.tabs.get = (tabId) => {
    if (tabId === 7) {
      lookupStarted = true;
      return delayedTabLookup.promise;
    }
    return getTab(tabId);
  };
  const staleStatus = sendExtensionMessage(fake.chromeApi, { type: 'popup-status' });
  await waitFor(() => lookupStarted);

  fake.setActiveTab(nextTab);
  assert.deepEqual(await connectToActivePopupTab(fake.chromeApi), {
    connected: true, ready: true,
  });
  delayedTabLookup.reject(new Error('old Canva tab closed'));
  assert.deepEqual(await staleStatus, { connected: false, ready: false });
  assert.deepEqual(await sendExtensionMessage(fake.chromeApi, { type: 'popup-status' }), {
    connected: true, ready: true,
  });
});

test('a presentation probe started before navigation cannot authorize editor input', async () => {
  const fake = fakeChrome('https://www.canva.com/design/deck-1/present');
  createCanvaExtensionWorker(fake.chromeApi);
  await connectToActivePopupTab(fake.chromeApi);

  const port = new FakePort('controller', { url: 'http://127.0.0.1:5173/' });
  fake.chromeApi.runtime.onConnect.fire(port);
  await waitFor(() => port.sent.some((message) => message.type === 'canva-target-state'));

  const delayedProbe = deferred();
  const sendMessage = fake.chromeApi.tabs.sendMessage.bind(fake.chromeApi.tabs);
  let holdProbe = true;
  fake.chromeApi.tabs.sendMessage = (tabId, message) => {
    if (message.type === 'probe' && holdProbe) {
      holdProbe = false;
      return delayedProbe.promise;
    }
    if (message.type === 'probe') return Promise.resolve({ ready: false });
    return sendMessage(tabId, message);
  };
  port.onMessage.fire({
    source: 'gesturedeck', type: 'canva-controller-request', id: 'navigation-race',
    command: 'navigate', action: 'next',
  });
  await waitFor(() => !holdProbe);

  fake.tab.url = 'https://www.canva.com/design/deck-1/edit';
  fake.chromeApi.tabs.onUpdated.fire(7, { url: fake.tab.url });
  await waitFor(() => port.sent.some((message) => message.type === 'canva-target-state'
    && message.connected === true && message.ready === false));

  delayedProbe.resolve({ ready: true });
  await waitFor(() => port.sent.some((message) => message.id === 'navigation-race'));

  assert.equal(fake.debuggerCalls.length, 0);
  assert.deepEqual(port.sent.find((message) => message.id === 'navigation-race'), {
    source: 'gesturedeck-extension', type: 'canva-controller-response',
    id: 'navigation-race', command: 'navigate', accepted: false,
  });
});

test('extension refuses a Canva editor page as a navigation target', async () => {
  const fake = fakeChrome('https://www.canva.com/design/deck-1/edit');
  createCanvaExtensionWorker(fake.chromeApi);
  assert.deepEqual(await connectToActivePopupTab(fake.chromeApi), {
    connected: false, ready: false, error: 'presentation-required',
  });
  assert.deepEqual(fake.injections, []);
});

test('extension clears a Canva target after the selected tab reloads without its content script', async () => {
  const fake = fakeChrome('https://www.canva.com/design/deck-1/present');
  createCanvaExtensionWorker(fake.chromeApi);
  await connectToActivePopupTab(fake.chromeApi);
  const port = new FakePort('controller', { url: 'http://127.0.0.1:5173/' });
  fake.chromeApi.runtime.onConnect.fire(port);
  await waitFor(() => port.sent.some((message) => message.type === 'canva-target-state'));
  fake.chromeApi.tabs.sendMessage = async () => { throw new Error('content script missing after reload'); };

  port.onMessage.fire({
    source: 'gesturedeck', type: 'canva-controller-request', id: 'status-1', command: 'status',
  });
  await waitFor(() => port.sent.some((message) => message.id === 'status-1'));
  assert.deepEqual(port.sent.find((message) => message.id === 'status-1'), {
    source: 'gesturedeck-extension', type: 'canva-controller-response',
    id: 'status-1', command: 'status', state: { connected: false, ready: false },
  });
});

test('Canva content script treats Present and View routes as ready by URL', async () => {
  const source = await readFile(new URL('../extension/content/canva-content.js', import.meta.url), 'utf8');
  const messages = [];
  const handlers = [];
  const location = { pathname: '/design/deck-1/view' };
  const windowListeners = new Map();
  const context = {
    location,
    chrome: { runtime: {
      onMessage: { addListener: (callback) => handlers.push(callback) },
      sendMessage: (message) => { messages.push(message); return Promise.resolve(); },
    } },
    window: { addEventListener: (name, callback) => windowListeners.set(name, callback) },
  };
  context.globalThis = context;
  runInNewContext(source, context);
  const receive = (message) => {
    let response;
    handlers[0](message, {}, (value) => { response = value; });
    return response;
  };
  const readiness = () => messages.filter(({ type }) => type === 'target-readiness').map(({ ready }) => ready);

  assert.deepEqual(readiness(), [true]);
  assert.equal(receive({ type: 'probe' }).ready, true);
  location.pathname = '/design/deck-1/present';
  assert.equal(receive({ type: 'probe' }).ready, true);
  location.pathname = '/design/deck-1/edit';
  assert.equal(receive({ type: 'probe' }).ready, false);
  windowListeners.get('popstate')();
  assert.deepEqual(readiness(), [true, false]);
});
