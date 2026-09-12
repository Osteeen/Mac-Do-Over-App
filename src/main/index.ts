import { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { createOverlayWindow, createEdgeWindow, createOnboardingWindow, setOverlayInteractive } from './windows.js';
import { handle } from './ipc.js';
import { permissionStatus, openPermissionPane, promptAccessibility } from './permissions.js';
import { startCapture, stopCapture, freeze, captureStats, screenPermission, requestScreenPermission } from './capture.js';
import { startInputSensor, stopInputSensor, input } from './sensors/input.js';
import { startWindowSensor, stopWindowSensor, front } from './sensors/windows.js';
import { runRecoveryGate, formatReport } from './gates/recovery-gate.js';
import type { PermissionPane } from '../shared/channels.js';
import { watchRoots, describeRoots } from './config.js';
import { Journal } from './journal/journal.js';
import { startMoveDetector, type MoveDetector } from './journal/move-detector.js';
import { Executor } from './executor/executor.js';
import { buildPreview } from './find/payload.js';
import { runFind } from './find/find.js';
import type { RestoreRequest, RestoreResult, StripSnapshot } from '../shared/types.js';

const args = process.argv.slice(1);
const gateArg = args.find(a => a.startsWith('--gate='))?.split('=')[1];
const outArg = args.find(a => a.startsWith('--out='))?.split('=')[1];

let tray: Tray | null = null;
let overlay: BrowserWindow | null = null;
let edge: BrowserWindow | null = null;
let onboarding: BrowserWindow | null = null;
let overlayOpen = false;
let journal: Journal | null = null;
let detector: MoveDetector | null = null;
let executor: Executor | null = null;
/** The last few frozen snapshots, so Find and approval act on exactly what the user was shown. */
const snapshots = new Map<string, StripSnapshot>();
function remember(s: StripSnapshot): StripSnapshot {
  snapshots.set(s.snapshotId, s);
  for (const id of [...snapshots.keys()].slice(0, -5)) snapshots.delete(id);
  return s;
}
/** Renderer arguments are untrusted: strings only, bounded length. */
const arg = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null);

function toggleOverlay(): void {
  if (!overlay) return;
  overlayOpen = !overlayOpen;
  if (overlayOpen) setOverlayInteractive(overlay, true);
  else { overlay.setIgnoreMouseEvents(true, { forward: true }); overlay.hide(); }
}

function buildTray(): void {
  const icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'assets', 'iconTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip(app.getName());
  // Gate and debug tools stay available for troubleshooting, but only when STARTER_DEBUG is set.
  const debugItems: Electron.MenuItemConstructorOptions[] = !process.env.STARTER_DEBUG ? [] : [
    { type: 'separator' },
    { label: 'Run recovery gate', click: async () => {
        const r = runRecoveryGate(app.isPackaged, process.execPath);
        const out = path.join(app.getPath('userData'), 'gates'); fs.mkdirSync(out, { recursive: true });
        fs.writeFileSync(path.join(out, 'recovery-gate.result.json'), JSON.stringify(r, null, 2));
        await dialog.showMessageBox({ message: r.pass ? 'Recovery gate: PASS' : 'Recovery gate: FAIL', detail: formatReport(r) + `\n\nWritten to ${out}` });
      } },
    { label: 'Capture stats', click: async () => { await dialog.showMessageBox({ message: 'Capture', detail: JSON.stringify(captureStats(), null, 2) }); } },
    { label: 'Request screen recording permission…', click: async () => {
        const r = await requestScreenPermission();
        await dialog.showMessageBox({ message: `Screen Recording: ${r.status}`, detail: r.note });
      } },
    { label: 'Journal snapshot (debug)', click: async () => { await dialog.showMessageBox({ message: 'Journal', detail: journal ? JSON.stringify(journal.freeze(), (_k, v) => typeof v === 'bigint' ? String(v) : v, 2).slice(0, 6000) : 'Journal not running' }); } },
  ];
  const menu = Menu.buildFromTemplate([
    { label: 'Open Mac Do Over (Option+Command+Z)', click: () => { if (!overlayOpen) toggleOverlay(); } },
    { type: 'separator' },
    { label: 'Watched folders', click: async () => { const w = watchRoots(); await dialog.showMessageBox({ message: describeRoots(w), detail: w.roots.join('\n') + (w.warnings.length ? '\n\n' + w.warnings.join('\n') : '') }); } },
    { label: 'Permissions…', click: () => { if (onboarding && !onboarding.isDestroyed()) onboarding.focus(); else onboarding = createOnboardingWindow(); } },
    ...debugItems,
    { type: 'separator' },
    { label: 'Quit Mac Do Over', click: () => app.quit() },
  ]);
  // Like any menu-bar app: a click drops the panel down or puts it away; a right-click shows this menu.
  tray.on('click', () => toggleOverlay());
  tray.on('right-click', () => tray?.popUpContextMenu(menu));
}

function registerIpc(): void {
  handle('permissions:status', () => permissionStatus());
  handle<[PermissionPane]>('permissions:open', (_e, pane) => { openPermissionPane(pane); if (pane === 'Accessibility') promptAccessibility(); return true; });
  handle<[boolean]>('overlay:set-interactive', (_e, on) => { if (overlay) setOverlayInteractive(overlay, on); return true; });
  handle('overlay:hide', () => { if (overlay) { overlayOpen = false; overlay.setIgnoreMouseEvents(true, { forward: true }); overlay.hide(); } return true; });
  handle('edge:activated', () => { if (!overlayOpen) toggleOverlay(); return true; });
  handle('app:info', () => ({ name: app.getName(), version: app.getVersion(), packaged: app.isPackaged, electron: process.versions.electron, node: process.versions.node }));
  handle('strip:snapshot', () => (journal ? remember(journal.freeze()) : null));
  handle<[unknown, unknown]>('find:preview', (_e, sid, ref) => {
    const s = snapshots.get(arg(sid, 32) ?? '');
    return s ? buildPreview(s, arg(ref, 2000) ?? '') : null;
  });
  handle<[unknown, unknown]>('find:send', async (_e, sid, ref) => {
    const s = snapshots.get(arg(sid, 32) ?? '');
    if (!s) return { status: 'error', reason: 'This list is out of date. Open it again.' };
    return runFind(s, arg(ref, 2000) ?? '');
  });
  handle<[unknown, unknown]>('approval:open', (_e, sid, cid) => {
    const s = arg(sid, 32), c = arg(cid, 32);
    return executor && s && c ? executor.openApproval(s, c) : null;
  });
  handle<[unknown]>('restore:approve', async (_e, raw): Promise<RestoreResult> => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const req: RestoreRequest = { candidateId: arg(r.candidateId, 32) ?? '', token: arg(r.token, 128) ?? '', mode: r.mode === 'recovered' ? 'recovered' : 'original' };
    if (!executor) return { status: 'refused', candidateId: req.candidateId, reason: 'halted', message: 'Mac Do Over is still starting. Nothing was changed.' };
    return executor.restore(req);
  });
}

async function main(): Promise<void> {
  if (gateArg === 'recovery') {                // headless gate run: no windows, prints and exits
    const r = runRecoveryGate(app.isPackaged, process.execPath);
    const text = formatReport(r);
    process.stdout.write(text + '\n');
    const outDir = outArg ?? path.join(app.getPath('userData'), 'gates');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'recovery-gate.result.json'), JSON.stringify(r, null, 2));
    process.stdout.write(`written: ${path.join(outDir, 'recovery-gate.result.json')}\n`);
    app.exit(r.pass ? 0 : 1); return;
  }
  if (gateArg === 'permissions') {          // prints all three and exits; no capture, no sensors
    const st = permissionStatus();
    let windowSensor = 'unknown';
    try {
      const mod = await import('get-windows');
      const w = await mod.activeWindow();
      windowSensor = w ? `working (frontmost: ${(w.owner as { name: string }).name})` : 'returned nothing';
    } catch (e) {
      windowSensor = `FAILING - ${String(e).split('\n')[0].slice(0, 160)}`;
    }
    process.stdout.write(JSON.stringify({
      screenRecording: st.screen,
      accessibility: st.accessibility,
      inputMonitoring: st.inputMonitoring,
      windowSensor,
      note: 'Screen Recording is needed for frames. Accessibility is needed for window titles, '
          + 'which is what get-windows uses. They are separate panes in System Settings.',
    }, null, 2) + '\n');
    app.exit(0); return;
  }
  if (gateArg === 'capture') {                 // measures capture + sensors running together
    if (process.platform === 'darwin') app.dock?.hide();
    const seconds = Number(args.find(a => a.startsWith('--seconds='))?.split('=')[1] ?? 30);
    const perm = screenPermission();
    process.stdout.write(`screen permission: ${perm}\n`);
    if (perm !== 'granted') {
      process.stdout.write(
        'REFUSING TO RUN. Screen Recording is not granted to this build.\n' +
        'Grant it first, from a normal launch, and answer the dialog before running this gate.\n' +
        'Running the capture loop while the permission dialog is open hangs the machine.\n');
      app.exit(2); return;
    }
    let clicks = 0, combos = 0, fronts = 0;
    input.on('click', () => clicks++); input.on('combo', () => combos++); front.on('change', () => fronts++);
    const inputOk = await startInputSensor();
    const windowOk = await startWindowSensor();
    const cap = startCapture();
    if (!cap.started) { process.stdout.write(`capture did not start: ${cap.reason}\n`); app.exit(2); return; }
    const t0 = Date.now(); const u0 = process.cpuUsage();
    await new Promise(r => setTimeout(r, seconds * 1000));
    const u = process.cpuUsage(u0); const elapsedUs = (Date.now() - t0) * 1000;
    const cpuPercent = ((u.user + u.system) / elapsedUs) * 100;
    const stats = captureStats();
    const report = {
      gate: 'capture', packaged: app.isPackaged, seconds,
      screenPermission: screenPermission(),
      inputSensorStarted: inputOk, windowSensorStarted: windowOk,
      framesInRing: stats.frames, expectedFrames: seconds * 3,
      ringMB: +(stats.bytes / 1048576).toFixed(1),
      avgFrameKB: stats.frames ? +(stats.bytes / stats.frames / 1024).toFixed(0) : 0,
      grabs: stats.grabs, captureErrors: stats.errors, lastCaptureError: stats.lastError,
      grabMsMedian: stats.grabMsMedian,
      clickEvents: clicks, comboEvents: combos, windowChanges: fronts,
      cpuPercent: +cpuPercent.toFixed(1),
      rssMB: +(process.memoryUsage().rss / 1048576).toFixed(0),
      ranAt: new Date().toISOString(),
    };
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    const outDir = outArg ?? path.join(app.getPath('userData'), 'gates');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'capture-gate.result.json'), JSON.stringify(report, null, 2));
    process.stdout.write(`written: ${path.join(outDir, 'capture-gate.result.json')}\n`);
    stopCapture();
    await stopInputSensor();
    stopWindowSensor();
    app.exit(0); return;
  }
  if (process.platform === 'darwin') app.dock?.hide();
  registerIpc();
  buildTray();
  overlay = createOverlayWindow();
  edge = createEdgeWindow();
  globalShortcut.register('Alt+CommandOrControl+Z', toggleOverlay);
  input.on('error', (e) => console.warn('[input sensor]', String(e)));
  front.on('error', (e) => console.warn('[window sensor]', String(e)));
  void startInputSensor();
  void startWindowSensor();
  // Sensor events are emitted, not stored: the starter has no journal. A product subscribes here.
  input.on('combo', (e) => { if (process.env.STARTER_DEBUG) console.log('[combo]', e.combo); });
  front.on('change', (e) => { if (process.env.STARTER_DEBUG) console.log('[front]', e.appName, '-', e.title); });
  const rootsCfg = watchRoots();
  console.log('[roots]', describeRoots(rootsCfg));
  for (const w of rootsCfg.warnings) console.warn('[roots]', w);

  journal = new Journal();
  const j = journal;
  executor = new Executor(j);
  front.on('change', (e) => j.recordFront(e.ts, e.appName, e.title));
  detector = startMoveDetector(rootsCfg, j);
  detector.on('ready', (n) => console.log('[journal] watching, files indexed:', n));
  detector.on('error', (e) => console.warn('[move detector]', String(e)));

  const st = permissionStatus();
  if (st.screen !== 'granted' || !st.accessibility) {
    // Show onboarding and do NOT start capture. Starting it while a permission dialog is
    // open queues blocked TCC checks against WindowServer and hangs the machine.
    onboarding = createOnboardingWindow();
  } else {
    const r = startCapture();
    if (!r.started) console.warn('[capture]', r.reason);
  }
  // Expose freeze() for products; exercised by the tray "Capture stats" item and the capture gate.
  void freeze;
}

app.whenReady().then(main);
let shuttingDown = false;
app.on('before-quit', (e) => {
  // Sensors must be stopped before the environment tears down, or uiohook's background
  // thread calls into a dead isolate and the process aborts instead of quitting.
  if (shuttingDown) return;
  e.preventDefault();
  shuttingDown = true;
  globalShortcut.unregisterAll();
  stopCapture();
  stopWindowSensor();
  void detector?.close();
  journal?.dispose();
  void stopInputSensor().finally(() => app.quit());
});
app.on('window-all-closed', () => { /* tray app: keep running */ });
