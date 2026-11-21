import { app, BrowserWindow, dialog } from 'electron';
import { startDesktopServer } from './server-lifecycle.mjs';

const WORKSPACE_URL = 'http://127.0.0.1:5173/workspace.html';
const WORKSPACE_ORIGIN = new URL(WORKSPACE_URL).origin;
let lifecycle;
let quitting = false;

async function openWorkspace() {
  lifecycle = await startDesktopServer();
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== WORKSPACE_ORIGIN) event.preventDefault();
  });
  await window.loadURL(WORKSPACE_URL);
}

app.whenReady().then(openWorkspace).catch(async (error) => {
  const message = error.code === 'EADDRINUSE'
    ? 'GestureDeck could not start because port 5173 is already in use. Close the other app using that port, then try again.'
    : `GestureDeck could not start its local workspace server: ${error.message}`;
  await dialog.showMessageBox({ type: 'error', title: 'GestureDeck startup failed', message });
  app.quit();
});

app.on('before-quit', (event) => {
  if (!lifecycle || quitting) return;
  event.preventDefault();
  quitting = true;
  lifecycle.stop().catch(() => {}).finally(() => app.quit());
});

app.on('window-all-closed', () => app.quit());
