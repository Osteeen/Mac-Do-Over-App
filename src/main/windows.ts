import { BrowserWindow, app, screen } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { allowSender } from './ipc.js';
const rendererDir = () => path.join(app.getAppPath(), 'renderer');
const preload = (name: string) => path.join(__dirname, '..', 'preload', `${name}.js`);
const base = (name: string) => ({ preload: preload(name), contextIsolation: true, nodeIntegration: false, sandbox: true });

/** Transparent overlay over the work area. Idle = click-through. Call setOverlayInteractive(true) before showing content that takes clicks. */
export function createOverlayWindow(): BrowserWindow {
  // The work area, not the whole display: the panel drops down below the menu bar instead of covering it.
  const { workArea } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height,
    transparent: true, frame: false, hasShadow: false, resizable: false, movable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, webPreferences: base('overlay'),
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  const url = pathToFileURL(path.join(rendererDir(), 'overlay.html')).toString();
  allowSender(win.webContents, url);
  void win.loadURL(url);
  return win;
}
export function setOverlayInteractive(win: BrowserWindow, on: boolean): void {
  win.setIgnoreMouseEvents(!on, { forward: true });
  if (on) { win.show(); win.focus(); }
}

/** Small always-on-top window docked to the right edge. Mechanics only; content is the product's. */
export function createEdgeWindow(): BrowserWindow {
  const { workArea } = screen.getPrimaryDisplay();
  const w = 10, h = 140;
  const win = new BrowserWindow({
    x: workArea.x + workArea.width - w, y: workArea.y + Math.round((workArea.height - h) / 2), width: w, height: h,
    transparent: true, frame: false, hasShadow: false, resizable: false, movable: false, focusable: false,
    alwaysOnTop: true, skipTaskbar: true, show: true, webPreferences: base('edge'),
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const url = pathToFileURL(path.join(rendererDir(), 'edge.html')).toString();
  allowSender(win.webContents, url);
  void win.loadURL(url);
  return win;
}

export function createOnboardingWindow(): BrowserWindow {
  const win = new BrowserWindow({ width: 520, height: 420, resizable: false, title: 'Permissions', webPreferences: base('onboarding') });
  const url = pathToFileURL(path.join(rendererDir(), 'onboarding.html')).toString();
  allowSender(win.webContents, url);
  void win.loadURL(url);
  return win;
}
