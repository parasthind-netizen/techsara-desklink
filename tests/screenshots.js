// Off-screen Chromium (Electron) walk-through of the redesigned site + console.
// Captures a PNG per screen and records every console warning/error (which
// includes Content-Security-Policy violations and failed resource loads).
//   electron shots.js <outDir> <creds.json> [only-prefix]
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT   = process.argv[2];
const CREDS = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const ONLY  = process.argv[4] || '';
const BASE  = process.env.DL_TEST_URL || 'http://127.0.0.1:3998';

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});   // windows come and go; quit only when the script says so
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.setPath('userData', path.join(OUT, '..', 'electron-profile'));

const logs = [];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makeWin(w, h, tag) {
  const win = new BrowserWindow({
    width: w, height: h, show: false, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false }
  });
  win.webContents.setFrameRate(30);
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) logs.push({ win: tag, level, message, source: String(source).replace(BASE, ''), line });
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (code !== -3) logs.push({ win: tag, level: 3, message: `did-fail-load ${code} ${desc} ${url}` });
  });
  return win;
}
const js = (win, code) => win.webContents.executeJavaScript(code, true);
async function shot(win, name) {
  if (ONLY && !name.startsWith(ONLY)) return;
  await sleep(450);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
}
async function setTheme(win, theme) {
  await js(win, `localStorage.setItem('dl_theme', ${JSON.stringify(theme)}); window.DLTheme && window.DLTheme.set(${JSON.stringify(theme)}); typeof syncThemeControls === 'function' && syncThemeControls(); true`);
  await sleep(200);
}
async function login(win, user, pass) {
  await js(win, `document.getElementById('admin-name').value = ${JSON.stringify(user)};
                 document.getElementById('admin-password').value = ${JSON.stringify(pass)};
                 document.getElementById('login-form').requestSubmit(); true`);
  for (let i = 0; i < 50; i++) {
    if (await js(win, `document.getElementById('app').style.display !== 'none'`)) break;
    await sleep(120);
  }
  await sleep(900);
}
const open = async (win, id) => { await js(win, `openTab(${JSON.stringify(id)}); true`); await sleep(500); };
const click = async (win, sel) => { await js(win, `(function(){ const e = document.querySelector(${JSON.stringify(sel)}); if (e) e.click(); return !!e; })()`); await sleep(350); };

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // ── A. Marketing site ──
  let win = makeWin(1440, 900, 'landing');
  await win.loadURL(BASE + '/'); await sleep(1200);
  await shot(win, '01-landing-hero');
  await js(win, `document.getElementById('features').scrollIntoView({behavior:'instant'}); true`); await shot(win, '02-landing-features');
  await js(win, `document.getElementById('how').scrollIntoView({behavior:'instant'}); true`); await shot(win, '02b-landing-how');
  await js(win, `document.getElementById('trust').scrollIntoView({behavior:'instant'}); true`); await shot(win, '02c-landing-trust');
  await js(win, `document.getElementById('download').scrollIntoView({behavior:'instant'}); true`); await shot(win, '03-landing-download');
  await js(win, `document.getElementById('access').scrollIntoView({behavior:'instant'}); true`);   await shot(win, '04-landing-access');
  await win.loadURL(BASE + '/download.html'); await sleep(900);
  await shot(win, '05-download-page');
  await click(win, '#tab-mac'); await shot(win, '05b-download-mac');
  win.destroy();

  win = makeWin(390, 844, 'landing-mobile');
  await win.loadURL(BASE + '/'); await sleep(1000);
  await shot(win, '06-landing-mobile');
  await js(win, `document.getElementById('download').scrollIntoView({behavior:'instant'}); true`); await shot(win, '06b-landing-mobile-download');
  await win.loadURL(BASE + '/download.html'); await sleep(900); await shot(win, '06c-download-mobile');
  await win.loadURL(BASE + '/dashboard'); await sleep(900);
  await setTheme(win, 'light');
  await shot(win, '07-login-mobile');
  win.destroy();

  // ── B. Sign-in ──
  win = makeWin(1440, 900, 'owner');
  await win.loadURL(BASE + '/dashboard'); await sleep(900);
  await setTheme(win, 'light');
  await shot(win, '08-login-light');
  await js(win, `document.getElementById('admin-name').value='paras'; document.getElementById('admin-password').value='wrong-password'; document.getElementById('login-form').requestSubmit(); true`);
  await sleep(1200);
  await shot(win, '09-login-error');
  await setTheme(win, 'dark');
  await shot(win, '10-login-dark');
  await setTheme(win, 'light');

  // ── C. Product owner, light ──
  await login(win, 'paras', 'ownerpass123');
  await shot(win, '11-owner-overview');
  await open(win, 'agents');           await shot(win, '12-owner-agents');
  await click(win, '.agent-card .card-menu-btn'); await shot(win, '13-agent-menu');
  await js(win, `document.body.click(); true`); await sleep(200);
  await open(win, 'admin');            await sleep(500); await shot(win, '14-console-customers');
  await click(win, '[data-otab="releases"]');  await shot(win, '15-console-releases');
  await click(win, '[data-otab="branding"]');  await shot(win, '16-console-branding');
  await click(win, '[data-otab="customers"]');
  await click(win, '#customers-tbody tr:first-child .actions .tbl-btn');   // Suspend → confirm dialog
  await shot(win, '17-dialog-confirm');
  await click(win, '#dlg-cancel');
  await click(win, '#customers-tbody tr:first-child button[data-limit]');  // prompt dialog
  await shot(win, '18-dialog-prompt');
  await click(win, '#dlg-cancel');
  await js(win, `document.getElementById('nc-name').value='Umbrella Health'; document.getElementById('nc-create').click(); true`);
  await sleep(900);                    await shot(win, '19-modal-credentials');
  await click(win, '#cc-done');
  await open(win, 'install');          await shot(win, '20-install');
  await click(win, '#install-create'); await shot(win, '21-modal-create-agent');
  await js(win, `document.getElementById('ca-name').value='Demo Laptop'; document.getElementById('ca-create').click(); true`);
  await sleep(700);                    await shot(win, '22-modal-agent-code');
  await click(win, '#ca-done');
  await open(win, 'activity');         await shot(win, '23-activity');
  await open(win, 'account');          await shot(win, '24-account');

  // ── D. Product owner, dark ──
  await setTheme(win, 'dark');
  await open(win, 'home');             await shot(win, '25-owner-overview-dark');
  await open(win, 'agents');           await shot(win, '26-owner-agents-dark');
  await open(win, 'admin');            await sleep(400); await shot(win, '27-console-dark');
  await click(win, '#customers-tbody tr:first-child .actions .tbl-del');
  await shot(win, '28-dialog-danger-dark');
  await click(win, '#dlg-cancel');

  // ── E. Live session view (the fake agent never answers → "connecting") ──
  await js(win, `connectToClient('Reception-PC'); true`); await sleep(900);
  await shot(win, '29-session-connecting');
  await js(win, `endCurrentSession(); openTabs = openTabs.filter(t => t !== 'session'); showView('agents'); true`);
  await sleep(400);
  await setTheme(win, 'light');
  win.destroy();

  // ── F. Customer (tenant owner) ──
  win = makeWin(1440, 900, 'customer');
  await win.loadURL(BASE + '/dashboard'); await sleep(900);
  await setTheme(win, 'light');
  await login(win, CREDS.acme.username, CREDS.acme.password);
  await shot(win, '30-customer-overview');
  await open(win, 'agents');           await shot(win, '31-customer-agents');
  await open(win, 'team');             await sleep(400); await shot(win, '32-customer-team');
  await open(win, 'account');          await shot(win, '33-customer-account');
  await setTheme(win, 'dark');
  await open(win, 'home');             await shot(win, '34-customer-overview-dark');
  await open(win, 'team');             await sleep(300); await shot(win, '35-customer-team-dark');
  await setTheme(win, 'light');
  win.destroy();

  // ── G. Narrow window → sidebar collapses to a rail ──
  win = makeWin(1024, 720, 'narrow');
  await win.loadURL(BASE + '/dashboard'); await sleep(900);
  await setTheme(win, 'light');
  await login(win, CREDS.acme.username, CREDS.acme.password);
  await open(win, 'agents');           await shot(win, '36-narrow-agents');
  await open(win, 'home');             await shot(win, '37-narrow-overview');
  win.destroy();

  fs.writeFileSync(path.join(OUT, 'console-log.json'), JSON.stringify(logs, null, 2));
  console.log('SHOTS_DONE issues=' + logs.length);
  app.quit();
}).catch((e) => { console.error('SHOTS_ERROR', e && e.stack || e); app.exit(1); });
