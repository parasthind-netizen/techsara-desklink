const { app, BrowserWindow, ipcMain, desktopCapturer, Tray, Menu, clipboard, session, powerSaveBlocker, screen, systemPreferences, shell } = require('electron');
const path = require('path');
const { mouse, keyboard, Button, Point, Key } = require('@nut-tree-fork/nut-js');
const os = require('os');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const { createRemoteInput } = require('./remote-input');
const watchdog = require('./watchdog');

// `DeskLink.exe --watchdog`: the guardian instance (see watchdog.js). No
// window, no tray, no updater, no single-instance lock — it only relaunches
// the real app when that disappears. Everything below is the real app.
if (process.argv.includes('--watchdog')) {
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});          // nothing to close; stay resident
  app.whenReady().then(() => watchdog.runWatchdog(process.execPath, (m) => console.log('[watchdog] ' + m)));
  return;
}

// ── Auto-update state ──
let updateReady        = false;   // an update has downloaded and is ready to install
let clientInSession    = false;   // a live support session is active — never interrupt it
let lastAttemptVersion = null;
let attemptFailures    = 0;
const FAIL_CAP = 3;               // stop retrying a bad version after 3 fails (anti brick-loop)
const failStorePath = () => path.join(app.getPath('userData'), 'update-fail.json');

function loadFailState() {
  try {
    const s = JSON.parse(fs.readFileSync(failStorePath(), 'utf8'));
    lastAttemptVersion = s.version; attemptFailures = s.count || 0;
  } catch (_) {}
}
function saveFailState() {
  try { fs.writeFileSync(failStorePath(), JSON.stringify({ version: lastAttemptVersion, count: attemptFailures })); }
  catch (_) {}
}

// Make remote input instant — nut-js defaults to a 100ms delay after every
// action, which makes the cursor crawl. Zero delay = real-time response.
mouse.config.autoDelayMs = 0;
keyboard.config.autoDelayMs = 0;
mouse.config.mouseSpeed = 99999;

let mainWindow;
let tray = null;
let isQuitting = false;
let mainPipe = null;   // watchdog liveness server — held for the life of the process

// Single instance — the close button hides to tray, so a user relaunching from
// the Start Menu would otherwise spawn a second copy fighting over the same
// identity. Instead, hand the relaunch to the running instance and re-show it.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
}

app.commandLine.appendSwitch('enable-usermedia-screen-capturing');

// The renderer owns the WebRTC capture + encode. Chromium deprioritizes
// hidden/occluded windows, which turns the remote view choppy the moment the
// user closes (hides) this window mid-session — so background dispensations
// are disabled at every layer Chromium applies them.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// Map browser event.code → nut-js Key (verified against installed version)
const CODE_TO_KEY = {
  KeyA: Key.A, KeyB: Key.B, KeyC: Key.C, KeyD: Key.D, KeyE: Key.E,
  KeyF: Key.F, KeyG: Key.G, KeyH: Key.H, KeyI: Key.I, KeyJ: Key.J,
  KeyK: Key.K, KeyL: Key.L, KeyM: Key.M, KeyN: Key.N, KeyO: Key.O,
  KeyP: Key.P, KeyQ: Key.Q, KeyR: Key.R, KeyS: Key.S, KeyT: Key.T,
  KeyU: Key.U, KeyV: Key.V, KeyW: Key.W, KeyX: Key.X, KeyY: Key.Y, KeyZ: Key.Z,
  Digit0: Key.Num0, Digit1: Key.Num1, Digit2: Key.Num2, Digit3: Key.Num3, Digit4: Key.Num4,
  Digit5: Key.Num5, Digit6: Key.Num6, Digit7: Key.Num7, Digit8: Key.Num8, Digit9: Key.Num9,
  Backquote: Key.Grave, Minus: Key.Minus, Equal: Key.Equal,
  BracketLeft: Key.LeftBracket, BracketRight: Key.RightBracket, Backslash: Key.Backslash,
  Semicolon: Key.Semicolon, Quote: Key.Quote, Comma: Key.Comma, Period: Key.Period, Slash: Key.Slash,
  Space: Key.Space, Enter: Key.Return, NumpadEnter: Key.Enter,
  Backspace: Key.Backspace, Delete: Key.Delete, Tab: Key.Tab, Escape: Key.Escape,
  Insert: Key.Insert, Home: Key.Home, End: Key.End, PageUp: Key.PageUp, PageDown: Key.PageDown,
  ArrowLeft: Key.Left, ArrowRight: Key.Right, ArrowUp: Key.Up, ArrowDown: Key.Down,
  ShiftLeft: Key.LeftShift, ShiftRight: Key.RightShift,
  ControlLeft: Key.LeftControl, ControlRight: Key.RightControl,
  AltLeft: Key.LeftAlt, AltRight: Key.RightAlt,
  // Meta = Win key on Windows, Cmd on macOS (libnut's "win" string is not a
  // reliable Command mapping on darwin — "cmd" is).
  MetaLeft:  process.platform === 'darwin' ? Key.LeftCmd  : Key.LeftWin,
  MetaRight: process.platform === 'darwin' ? Key.RightCmd : Key.RightWin,
  CapsLock: Key.CapsLock, NumLock: Key.NumLock, ScrollLock: Key.ScrollLock,
  F1: Key.F1, F2: Key.F2, F3: Key.F3, F4: Key.F4, F5: Key.F5, F6: Key.F6,
  F7: Key.F7, F8: Key.F8, F9: Key.F9, F10: Key.F10, F11: Key.F11, F12: Key.F12,
  Numpad0: Key.NumPad0, Numpad1: Key.NumPad1, Numpad2: Key.NumPad2, Numpad3: Key.NumPad3,
  Numpad4: Key.NumPad4, Numpad5: Key.NumPad5, Numpad6: Key.NumPad6, Numpad7: Key.NumPad7,
  Numpad8: Key.NumPad8, Numpad9: Key.NumPad9,
  NumpadAdd: Key.Add, NumpadSubtract: Key.Subtract,
  NumpadMultiply: Key.Multiply, NumpadDivide: Key.Divide, NumpadDecimal: Key.Decimal,
  PrintScreen: Key.Print, Pause: Key.Pause, ContextMenu: Key.Menu,
};

// Dashboard → OS input pipeline (ordered queue, DPI/multi-monitor mapping).
const remoteInput = createRemoteInput({
  screen, mouse, keyboard, Button, Point,
  codeToKey: CODE_TO_KEY,
  log: (m) => console.error(m)
});

// The display whose pixels go on the wire. Remote input is mapped onto THIS
// display's bounds, so it must be the one actually captured — enumeration
// order is not guaranteed to put the primary first, so match on display_id.
function pickCaptureSource(sources) {
  if (!sources || !sources.length) return null;
  const primaryId = String(screen.getPrimaryDisplay().id);
  const source = sources.find(s => String(s.display_id) === primaryId) || sources[0];
  remoteInput.setCapturedDisplay(source.display_id);
  return source;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 560,
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false   // stream must not degrade when hidden to tray
    }
  });
  mainWindow.loadFile('index.html');

  // Close hides to tray — only "Exit Completely" truly quits
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
    return false;
  });
}

function createTray() {
  try {
    tray = new Tray(path.join(__dirname, 'tray.png'));   // printer glyph — app icon stays icon.png
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Open DeskLink', click: () => mainWindow.show() },
      { type: 'separator' },
      { label: 'Exit Completely', click: () => { isQuitting = true; watchdog.stopWatchdog().finally(() => app.quit()); } }
    ]);
    tray.setToolTip('DeskLink');
    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => mainWindow.show());
  } catch (e) {
    console.log('Tray icon not created (icon.png missing)');
  }
}

app.whenReady().then(() => {
  // Modern screen-capture path — reliably avoids the black-screen bug in Electron 28.
  // Auto-selects the primary screen, no picker dialog.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).then((sources) => {
      const source = pickCaptureSource(sources);
      if (source) callback({ video: source });
      else callback({});
    }).catch(() => callback({}));
  });

  createWindow();
  createTray();
  setupAutoUpdate();
  // Liveness pipe first, so the watchdog's first probe finds us; then the
  // watchdog itself (packaged builds only — in dev, execPath is electron.exe).
  watchdog.startMainPipe().then((srv) => {
    mainPipe = srv;
    if (!app.isPackaged) return;
    if (!srv) {
      // Without liveness a watchdog would relaunch us in a loop — don't start one.
      console.warn('[watchdog] liveness pipe unavailable — watchdog not started');
      return;
    }
    const ensure = () => watchdog.ensureWatchdog(process.execPath, (m) => console.log('[watchdog] ' + m));
    ensure();
    setInterval(ensure, 60 * 1000);   // and bring the watchdog back if *it* gets killed
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// ── Auto-update: silent per-user NSIS swap driven by the self-hosted feed ──
function maybeInstall() {
  if (!updateReady || clientInSession) return;   // never interrupt a live support session
  isQuitting = true;                              // defeat the tray close→hide handler
  // The watchdog must not relaunch the old exe while the installer swaps it;
  // the relaunched, updated app starts a fresh watchdog.
  watchdog.stopWatchdog().finally(() =>
    setImmediate(() => autoUpdater.quitAndInstall(true, true))); // silent + relaunch (agent auto-reconnects)
}

function setupAutoUpdate() {
  if (!app.isPackaged) return;                    // no feed in dev
  loadFailState();
  autoUpdater.autoDownload         = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // CloudFront cannot serve multipart/byteranges, so differential updates can
  // never work through it — skip the doomed attempt and go straight to the
  // full download.
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.allowDowngrade       = false;       // default: never go backward (only a rollback push flips this)

  const send = (d) => mainWindow && !mainWindow.isDestroyed()
                    && mainWindow.webContents.send('update-status', d);

  autoUpdater.on('update-available', (i) => {
    // Anti-loop: if this exact version already failed FAIL_CAP times, stop trying it.
    if (i.version === lastAttemptVersion && attemptFailures >= FAIL_CAP) {
      send({ state: 'failed', version: i.version });
      autoUpdater.autoDownload = false;
      return;
    }
    lastAttemptVersion = i.version; saveFailState();
    send({ state: 'available', version: i.version });
  });
  autoUpdater.on('update-not-available', () => { autoUpdater.allowDowngrade = false; send({ state: 'none' }); });
  autoUpdater.on('download-progress', (p) => send({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('error', (e) => {
    attemptFailures++; saveFailState();
    autoUpdater.allowDowngrade = false;
    send({ state: 'error', message: String(e) });
  });
  autoUpdater.on('update-downloaded', (i) => {
    attemptFailures = 0; saveFailState();
    autoUpdater.allowDowngrade = false;
    updateReady = true; send({ state: 'ready', version: i.version });
    maybeInstall();
  });

  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 8000);            // ~8s after launch
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 60 * 60 * 1000); // hourly (throttled, never tight)
}

// Dashboard push (relayed via renderer socket). opts.allowDowngrade=true for a rollback.
ipcMain.handle('check-for-update', (_e, opts) => {
  opts = opts || {};
  autoUpdater.autoDownload   = true;              // re-arm in case a prior failure disabled it
  autoUpdater.allowDowngrade = !!opts.allowDowngrade;
  return autoUpdater.checkForUpdates().catch((e) => ({ error: String(e) }));
});
let sleepBlockerId = null;
ipcMain.on('session-state', (_e, inSession) => {
  clientInSession = !!inSession;
  // While a session is live, keep the display awake — Windows blanking the
  // screen mid-session freezes the captured stream on the agent's side.
  if (clientInSession && sleepBlockerId === null) {
    sleepBlockerId = powerSaveBlocker.start('prevent-display-sleep');
  } else if (!clientInSession && sleepBlockerId !== null) {
    powerSaveBlocker.stop(sleepBlockerId);
    sleepBlockerId = null;
  }
  if (!clientInSession) {
    remoteInput.releaseAll();                     // never leave a button/modifier held after a session
    maybeInstall();                               // apply a queued update the instant the session ends
  }
});
ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.handle('get-platform', () => process.platform);

// ── macOS TCC permissions ──
// Screen Recording and Accessibility are user-granted in System Settings.
// Without Screen Recording the capture silently shows wallpaper-only frames;
// without Accessibility every remote input call is a no-op — so the renderer
// surfaces both until granted. Screen Recording only takes effect after an
// app restart, which the renderer offers via 'relaunch-app'.
function macPermissionState() {
  if (process.platform !== 'darwin') return { platform: process.platform, screen: 'granted', accessibility: true, needsMove: false };
  let screenStatus = 'unknown';
  try { screenStatus = systemPreferences.getMediaAccessStatus('screen'); } catch (_) {}
  let ax = false;
  try { ax = systemPreferences.isTrustedAccessibilityClient(false); } catch (_) {}
  // Auto-start (and watchdog kill-protection) only work from a stable
  // location. If the app is running from the DMG or a translocated path, the
  // fix is to move it to Applications — surface that in the banner.
  const needsMove = app.isPackaged && !watchdog.isStableMacExecPath(process.execPath);
  return { platform: 'darwin', screen: screenStatus, accessibility: ax, needsMove };
}
ipcMain.handle('get-permissions', () => macPermissionState());
ipcMain.handle('request-accessibility', () => {
  if (process.platform !== 'darwin') return true;
  try { return systemPreferences.isTrustedAccessibilityClient(true); }  // prompts + lists the app
  catch (_) { return false; }
});
ipcMain.handle('open-permission-settings', (_e, which) => {
  if (process.platform !== 'darwin') return;
  const pane = which === 'screen' ? 'Privacy_ScreenCapture' : 'Privacy_Accessibility';
  return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?' + pane);
});
ipcMain.handle('relaunch-app', () => {
  isQuitting = true;
  // Same dance as an update install: silence the watchdog so it doesn't race
  // the relaunch; the fresh instance starts it again.
  watchdog.stopWatchdog().finally(() => { app.relaunch(); app.exit(0); });
});

// The agent must stay resident on every platform — closing the window hides
// to tray, and only "Exit Completely" quits. (The old darwin quit here would
// have killed an unattended Mac desk the moment its window closed.)
app.on('window-all-closed', () => {});

ipcMain.handle('get-screen-sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'] });
  return sources;
});

ipcMain.handle('get-machine-name', () => {
  try { return os.hostname() + ' - ' + os.userInfo().username; }
  catch (e) { return 'Unknown-PC'; }
});

// Clipboard IPC
ipcMain.handle('clipboard-read', () => clipboard.readText());
ipcMain.on('clipboard-write', (event, text) => clipboard.writeText(String(text)));

// Remote input: mouse, keyboard, scroll — all via WebRTC data channel.
// Parsed here, applied in order by remote-input.js (see there for the
// coordinate mapping and why events must be serialised).
ipcMain.on('handle-input', (event, data) => {
  let input;
  try { input = JSON.parse(data); } catch (_) { return; }
  remoteInput.enqueue(input);
});
