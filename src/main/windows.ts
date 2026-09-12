import { BrowserWindow, app, screen } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { allowSender } from './ipc.js';
const rendererDir = () => path.join(app.getAppPath(), 'renderer');
const preload = (name: string) => path.join(__dirname, '..', 'preload', `${name}.js`);
const base = (name: string) => ({ preload: preload(name), contextIsolation: true, nodeIntegration: false, sandbox: true });

const OVERLAY_WIDTH = 480;
const OVERLAY_MAX_HEIGHT = 860;
const EDGE_MARGIN = 4;

/**
 * Panel-sized menu-bar popover: a transparent frameless window exactly as wide as the panel
 * (the page lays a 460px panel inside it), dropped from the top of the work area.
 * It is created hidden at the top-right of the primary work area; call positionOverlay()
 * before showing it so it sits under the tray icon. Because the window is only the panel,
 * it is not click-through: it takes mouse events whenever it is shown, and clicks outside it
 * land on other apps (main hides it on blur).
 */
export function createOverlayWindow(): BrowserWindow {
  // The work area, not the whole display: the panel drops down below the menu bar instead of covering it.
  const { workArea } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    x: workArea.x + workArea.width - OVERLAY_WIDTH - EDGE_MARGIN, y: workArea.y,
    width: OVERLAY_WIDTH, height: Math.min(workArea.height, OVERLAY_MAX_HEIGHT),
    transparent: true, frame: false, hasShadow: false, resizable: false, movable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, webPreferences: base('overlay'),
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const url = pathToFileURL(path.join(rendererDir(), 'overlay.html')).toString();
  allowSender(win.webContents, url);
  void win.loadURL(url);
  return win;
}

/** Place the overlay under the tray icon, on the display that holds it, clamped inside the work area. */
export function positionOverlay(win: BrowserWindow, trayBounds?: Electron.Rectangle): void {
  const hasBounds = !!trayBounds && trayBounds.width > 0 && trayBounds.height > 0;
  const display = hasBounds ? screen.getDisplayMatching(trayBounds!) : screen.getPrimaryDisplay();
  const { workArea } = display;
  const width = OVERLAY_WIDTH;
  const height = Math.min(workArea.height, OVERLAY_MAX_HEIGHT);
  const minX = workArea.x + EDGE_MARGIN;
  const maxX = workArea.x + workArea.width - width - EDGE_MARGIN;
  const wanted = hasBounds
    ? Math.round(trayBounds!.x + trayBounds!.width / 2 - width / 2)
    : maxX;
  const x = Math.max(minX, Math.min(wanted, maxX));
  win.setBounds({ x, y: workArea.y, width, height });
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
