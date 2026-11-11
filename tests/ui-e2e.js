// Click-through tests of the real pages in off-screen Chromium (Electron).
// Drives the console the way a person does — buttons, dialogs, forms — and
// asserts what ends up on screen. Any console warning/error (which includes
// Content-Security-Policy violations and failed loads) fails the run.
//   electron ui-e2e.js <creds.json>
// Needs the scratch server on :3998 seeded by seed-demo.js and started with -NoMac
// (tests/run-all.ps1 does all of that).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');

const CREDS = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const BASE = process.env.DL_TEST_URL || 'http://127.0.0.1:3998';
const OWNER = { user: 'paras', pass: 'ownerpass123' };

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.setPath('userData', path.join(require('os').tmpdir(), 'desklink-scratch', 'electron-profile-ui-' + (new URL(BASE).port || '80')));

const R = [];
const logs = [];
const check = (n, c) => { R.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makeWin(w, h, tag) {
  const win = new BrowserWindow({ width: w, height: h, show: false, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) logs.push(`[${tag}] ${message} (${String(source).replace(BASE, '')}:${line})`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => { if (code !== -3) logs.push(`[${tag}] did-fail-load ${code} ${desc} ${url}`); });
  return win;
}
const js = (win, code) => win.webContents.executeJavaScript(code, true);
const Q = JSON.stringify;
// Poll an expression until it is truthy; returns its value (or false on timeout).
async function until(win, expr, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    let v = false;
    try { v = await js(win, `(function(){ try { return (${expr}); } catch (e) { return false; } })()`); } catch (_) {}
    if (v) return v;
    if (Date.now() > end) return false;
    await sleep(70);
  }
}
const text = (win, sel) => js(win, `(function(){ const e = document.querySelector(${Q(sel)}); return e ? e.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
const count = (win, sel) => js(win, `document.querySelectorAll(${Q(sel)}).length`);
const shown = (win, sel) => js(win, `(function(){ const e = document.querySelector(${Q(sel)}); if (!e) return false; const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0; })()`);
const click = async (win, sel) => { const ok = await js(win, `(function(){ const e = document.querySelector(${Q(sel)}); if (!e) return false; e.click(); return true; })()`); await sleep(120); return ok; };
const fill = (win, sel, value) => js(win, `(function(){ const e = document.querySelector(${Q(sel)}); if (!e) return false; e.value = ${Q(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const key = (win, sel, k) => js(win, `(function(){ const e = document.querySelector(${Q(sel)}); if (!e) return false; e.dispatchEvent(new KeyboardEvent('keydown', { key: ${Q(k)}, bubbles: true, cancelable: true })); return true; })()`);
// The newest toast whose text matches.
const toast = (win, re, ms = 4000) => until(win, `Array.from(document.querySelectorAll('#toast-stack .toast')).some(t => ${re}.test(t.textContent))`, ms);
// A row / card located by the text of one of its cells.
const rowSel = (tbody, label) => `(Array.from(document.querySelectorAll('#${tbody} tr')).find(tr => tr.textContent.includes(${Q(label)})))`;
const cardSel = (name) => `(Array.from(document.querySelectorAll('#agents-grid .agent-card')).find(c => c.querySelector('.ac-name').textContent === ${Q(name)}))`;
const clickIn = async (win, scopeExpr, btnText) => {
  const ok = await js(win, `(function(){ const s = ${scopeExpr}; if (!s) return false; const b = Array.from(s.querySelectorAll('button')).find(b => b.textContent.trim() === ${Q(btnText)}); if (!b || b.disabled) return false; b.click(); return true; })()`);
  await sleep(150);
  return ok;
};
const dialogOpen = (win) => until(win, `getComputedStyle(document.getElementById('ui-dialog')).display !== 'none'`, 2500);
const dialogGone = (win) => until(win, `getComputedStyle(document.getElementById('ui-dialog')).display === 'none'`, 2500);
const view = (win) => js(win, `document.getElementById('app').dataset.view`);
const nav = async (win, id) => { await click(win, `.nav-item[data-open="${id}"]`); await sleep(250); };
const cardStatus = (win, name) => js(win, `(function(){ const c = ${cardSel(name)}; return c ? c.querySelector('.status-pill').textContent.trim() : null; })()`);
const cardMenu = async (win, name, item) => {
  await js(win, `(function(){ const c = ${cardSel(name)}; if (c) c.querySelector('.card-menu-btn').click(); })()`);
  await sleep(150);
  const ok = await js(win, `(function(){ const c = ${cardSel(name)}; if (!c) return false; const b = Array.from(c.querySelectorAll('.card-menu button')).find(b => b.textContent.trim() === ${Q(item)}); if (!b || b.disabled) return false; b.click(); return true; })()`);
  await sleep(150);
  return ok;
};
async function signIn(win, user, pass) {
  await fill(win, '#admin-name', user);
  await fill(win, '#admin-password', pass);
  await js(win, `document.getElementById('login-form').requestSubmit(); true`);
}
const appShown = (win, ms = 6000) => until(win, `getComputedStyle(document.getElementById('app')).display !== 'none'`, ms);
const loginShown = (win, ms = 6000) => until(win, `getComputedStyle(document.getElementById('login-screen')).display !== 'none' && !document.getElementById('login-screen').classList.contains('resuming')`, ms);
const getJSON = (p) => new Promise((res) => http.get(BASE + p, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (_) { res(null); } }); }).on('error', () => res(null)));

app.whenReady().then(async () => {
  // ═════════════ 1. SIGN-IN PAGE ═════════════
  let win = makeWin(1440, 900, 'owner');
  await win.loadURL(BASE + '/dashboard'); await sleep(700);
  check('sign-in: page shows the form, not the app', await shown(win, '#login-form') && !(await shown(win, '#app')));
  check('sign-in: brand panel and "need access" help are present', await shown(win, '.auth-brand') && /support@techsarasolutions\.com/.test(await text(win, '#login-screen')));
  await js(win, `document.getElementById('login-form').requestSubmit(); true`); await sleep(200);
  check('sign-in: empty form asks for the details', /Enter your Customer ID/.test(await text(win, '#login-error') || ''));
  await js(win, `document.getElementById('login-pwd-eye').click(); true`);
  check('sign-in: the eye button reveals the password', (await js(win, `document.getElementById('admin-password').type`)) === 'text');
  await js(win, `document.getElementById('login-pwd-eye').click(); true`);
  check('sign-in: and hides it again', (await js(win, `document.getElementById('admin-password').type`)) === 'password');
  await signIn(win, OWNER.user, 'definitely-wrong');
  check('sign-in: a wrong password shows an error and stays on the page', await until(win, `/Invalid username or password/.test(document.getElementById('login-error').textContent)`) && !(await shown(win, '#app')));
  check('sign-in: the button is usable again after the error', await until(win, `!document.getElementById('login-btn').classList.contains('is-busy')`, 3000));
  const themeBefore = await js(win, `document.documentElement.dataset.theme || window.DLTheme.resolved()`);
  await click(win, '#login-screen [data-theme-toggle]');
  const themeAfter = await js(win, `document.documentElement.dataset.theme`);
  check('sign-in: the theme switch works before signing in', themeAfter && themeAfter !== themeBefore);
  await js(win, `window.DLTheme.set('light'); true`);

  // ═════════════ 2. OWNER: OVERVIEW ═════════════
  await signIn(win, OWNER.user, OWNER.pass);
  check('owner: signs in and lands on Overview', await appShown(win) && (await view(win)) === 'home');
  check('owner: greeted by name, labelled Product owner', /paras/.test(await text(win, '#home-greeting')) && /Product owner/.test(await text(win, '#user-role')));
  await until(win, `document.getElementById('kpi-online').textContent === '5'`, 4000);
  check('owner: KPIs — 5 online of 7', (await text(win, '#kpi-online')) === '5' && /of 7 agents/.test(await text(win, '#kpi-online-foot')));
  check('owner: KPIs — 4 available, 0 in session, 1 awaiting install', (await text(win, '#kpi-available')) === '4' && (await text(win, '#kpi-session')) === '0' && (await text(win, '#kpi-install')) === '1');
  check('owner: KPIs — 3 customers, 1 suspended', await until(win, `document.getElementById('kpi-customers').textContent === '3'`, 3000) && /1 suspended/.test(await text(win, '#kpi-customers-foot')));
  check('owner: "Ready to connect" lists the 4 reachable agents with their customer', (await count(win, '#home-ready .list-row')) === 4 && /Acme Retail/.test(await text(win, '#home-ready')));
  check('owner: recent activity is shown', (await count(win, '#home-events .event-row')) >= 2);
  const stored = await js(win, `JSON.stringify(Object.assign({}, sessionStorage)) + JSON.stringify(Object.assign({}, localStorage))`);
  check('security: the password is never stored in the browser', !stored.includes(OWNER.pass) && /ts_agent_token/.test(stored) && !/ts_agent_pwd/.test(stored));
  check('owner: owner-only navigation is visible, Team is not', await shown(win, '.nav-item[data-open="admin"]') && !(await shown(win, '.nav-item[data-open="team"]')));

  // ═════════════ 3. NAVIGATION ═════════════
  for (const [id, title] of [['agents', 'Agents'], ['install', 'Install Agent'], ['activity', 'Activity'], ['admin', 'Owner Console'], ['account', 'My Account'], ['home', 'Overview']]) {
    await nav(win, id);
    check(`nav: ${title}`, (await view(win)) === id && (await text(win, '#page-title')) === title && await shown(win, '#view-' + id));
  }
  await js(win, `document.querySelector('[data-kpi="available"]').click(); true`); await sleep(250);
  check('nav: a KPI card opens Agents with that filter', (await view(win)) === 'agents' && (await count(win, '#agents-grid .agent-card')) === 4);

  // ═════════════ 4. AGENTS ═════════════
  await click(win, '[data-filter="all"]');
  check('agents: all 7 are listed', (await count(win, '#agents-grid .agent-card')) === 7);
  const expectByFilter = { available: 4, unavailable: 1, offline: 1, toinstall: 1 };
  let filtersOk = true;
  for (const f of Object.keys(expectByFilter)) { await click(win, `[data-filter="${f}"]`); if ((await count(win, '#agents-grid .agent-card')) !== expectByFilter[f]) filtersOk = false; }
  check('agents: each status filter shows the right machines', filtersOk);
  await click(win, '[data-filter="insession"]');
  check('agents: an empty filter explains itself', await shown(win, '#agents-empty') && /No agents match/.test(await text(win, '#agents-empty-title')));
  await click(win, '[data-filter="all"]');
  await fill(win, '#agents-search', 'globex');
  check('agents: the name filter narrows the list', await until(win, `document.querySelectorAll('#agents-grid .agent-card').length === 2`, 2000));
  await fill(win, '#agents-search', '');
  await sleep(150);
  await js(win, `window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })); true`);
  check('agents: "/" jumps to the search box', (await js(win, `document.activeElement && document.activeElement.id`)) === 'home-search');
  await fill(win, '#home-search', 'ware'); await key(win, '#home-search', 'Enter'); await sleep(250);
  check('agents: the top search finds a machine', (await count(win, '#agents-grid .agent-card')) === 1 && /Warehouse-01/.test(await text(win, '#agents-grid')));
  await fill(win, '#agents-search', ''); await fill(win, '#home-search', ''); await sleep(150);
  check('agents: the owner sees which customer each machine belongs to', /Customer Acme Retail · TS-0001/.test(await js(win, `(${cardSel('Reception-PC')}).textContent`)));
  check('agents: platform and version are shown', /Windows · v1\.4\.1/.test(await js(win, `(${cardSel('Reception-PC')}).textContent`)) && /macOS · v1\.4\.0/.test(await js(win, `(${cardSel('Accounts-MacBook')}).textContent`)));
  check('agents: a pending machine shows its installation code', /^\d{3}-\d{3}-\d{3}$/.test(await js(win, `(${cardSel('Front-Desk-2')}).querySelector('.ac-code span').textContent`)));

  // dashboard on/off switch (the fake Warehouse-01 is online with access off)
  check('agents: Warehouse-01 starts with access off', (await cardStatus(win, 'Warehouse-01')) === 'Access off');
  check('agents: menu → Turn support access on', await cardMenu(win, 'Warehouse-01', 'Turn support access on'));
  check('agents: the card becomes Available and a toast confirms it', await until(win, `(${cardSel('Warehouse-01')}).querySelector('.status-pill').textContent.trim() === 'Available'`) && await toast(win, '/turned on for Warehouse-01/'));
  await cardMenu(win, 'Warehouse-01', 'Turn support access off');
  check('agents: and can be turned off again', await until(win, `(${cardSel('Warehouse-01')}).querySelector('.status-pill').textContent.trim() === 'Access off'`));
  await click(win, '#agents-refresh');
  check('agents: Refresh re-fetches the list from the server', await toast(win, '/Agent list is up to date/'));

  // create → pending card → delete
  await click(win, '#agents-add');
  check('add agent: the dialog opens', await shown(win, '#create-agent-modal') && await shown(win, '#ca-step1'));
  await fill(win, '#ca-name', '!'); await click(win, '#ca-create');
  check('add agent: an invalid name is rejected with a reason', await until(win, `getComputedStyle(document.getElementById('ca-error')).display !== 'none' && document.getElementById('ca-error').textContent.length > 5`, 3000));
  await fill(win, '#ca-name', 'UI Test PC'); await click(win, '#ca-create');
  check('add agent: a valid name returns an installation code', await until(win, `/^\\d{3}-\\d{3}-\\d{3}$/.test(document.getElementById('ca-code').textContent)`) && (await text(win, '#ca-created-name')) === 'UI Test PC');
  check('add agent: the download link points at this server', /\/download\.html$/.test(await text(win, '#ca-dl-link') || ''));
  await click(win, '#ca-done');
  check('add agent: it appears as "To install"', await until(win, `!!(${cardSel('UI Test PC')})`) && (await cardStatus(win, 'UI Test PC')) === 'To install');
  await fill(win, '#ca-name', ''); await click(win, '#agents-add'); await fill(win, '#ca-name', 'UI Test PC'); await click(win, '#ca-create');
  check('add agent: a duplicate name is refused', await until(win, `/already exists/.test(document.getElementById('ca-error').textContent)`, 3000));
  await js(win, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); true`); await sleep(150);
  check('add agent: Escape closes the dialog', !(await shown(win, '#create-agent-modal')));
  await cardMenu(win, 'UI Test PC', 'Delete this code');
  check('delete code: asks for confirmation first', await dialogOpen(win) && /Delete this installation code/.test(await text(win, '#dlg-title')));
  await click(win, '#dlg-cancel'); await dialogGone(win);
  check('delete code: Cancel keeps it', !!(await js(win, `!!(${cardSel('UI Test PC')})`)));
  await cardMenu(win, 'UI Test PC', 'Delete this code'); await dialogOpen(win); await click(win, '#dlg-ok');
  check('delete code: confirming removes it', await until(win, `!(${cardSel('UI Test PC')})`));

  // ═════════════ 5. LIVE SESSION ═════════════
  await js(win, `(${cardSel('Reception-PC')}).querySelector('.ac-foot .btn').click(); true`); await sleep(400);
  check('session: Connect opens the session view', (await view(win)) === 'session' && (await text(win, '#session-client-name')) === 'Reception-PC');
  check('session: it shows a connecting state', /Connecting to Reception-PC/.test(await text(win, '#placeholder-text') || ''));
  check('session: the sidebar gets a live-session entry', await shown(win, '#nav-session'));
  check('session: controls are present', await shown(win, '#disconnect-btn') && await shown(win, '#reconnect-btn') && await shown(win, '#ctrl-quality') && await shown(win, '#fullscreen-btn'));
  await nav(win, 'agents');
  check('session: the machine is marked "In session with you"', await until(win, `(${cardSel('Reception-PC')}).querySelector('.status-pill').textContent.trim() === 'In session with you'`, 3000));
  check('session: Overview counts it', (await js(win, `document.getElementById('kpi-session').textContent`)) === '1');
  await js(win, `(${cardSel('Reception-PC')}).querySelector('.ac-foot .btn').click(); true`); await sleep(300);
  check('session: "Open session" returns to it', (await view(win)) === 'session');
  await click(win, '#disconnect-btn'); await sleep(400);
  check('session: End session leaves the view', (await view(win)) !== 'session' && !(await shown(win, '#nav-session')));
  await nav(win, 'agents');
  check('session: the machine is Available again', await until(win, `(${cardSel('Reception-PC')}).querySelector('.status-pill').textContent.trim() === 'Available'`, 3000));

  // ═════════════ 6. OWNER CONSOLE ═════════════
  await nav(win, 'admin');
  check('console: 3 customers listed with agent and seat counts', await until(win, `document.querySelectorAll('#customers-tbody tr').length === 3`) && /5\s*2 \/ 5/.test(await js(win, `${rowSel('customers-tbody', 'Acme Retail')}.textContent.replace(/Edit.*/, '')`)));
  check('console: summary tiles', (await text(win, '#os-customers')) === '3' && (await text(win, '#os-agents')) === '7' && (await text(win, '#os-team')) === '2');
  await fill(win, '#nc-name', 'UI Test Co'); await fill(win, '#nc-limit', '2'); await click(win, '#nc-create');
  check('console: creating a customer shows one-time credentials', await until(win, `getComputedStyle(document.getElementById('cust-cred-modal')).display !== 'none'`) && /^TS-\d{4}$/.test(await text(win, '#cc-id')) && (await text(win, '#cc-pass')).length >= 8);
  const newId = await text(win, '#cc-id'), newPass = await text(win, '#cc-pass');
  check('console: the login is the Customer ID in lower case', (await text(win, '#cc-login')) === newId.toLowerCase() && /\/dashboard$/.test(await text(win, '#cc-url')));
  await js(win, `document.getElementById('cust-cred-modal').click(); true`); await sleep(150);
  check('console: a stray click outside does not lose the one-time password', await shown(win, '#cust-cred-modal'));
  await click(win, '#cc-done');
  check('console: the new customer is in the table with its limit', await until(win, `!!${rowSel('customers-tbody', 'UI Test Co')}`) && /0 \/ 2/.test(await js(win, `${rowSel('customers-tbody', 'UI Test Co')}.textContent`)));
  await clickIn(win, rowSel('customers-tbody', 'UI Test Co'), 'Edit');
  check('console: Edit limit opens a prompt with the current value', await dialogOpen(win) && (await js(win, `document.getElementById('dlg-input').value`)) === '2');
  await fill(win, '#dlg-input', '4'); await click(win, '#dlg-ok');
  check('console: the new limit is saved', await until(win, `/0 \\/ 4/.test(${rowSel('customers-tbody', 'UI Test Co')}.textContent)`));
  await clickIn(win, rowSel('customers-tbody', 'UI Test Co'), 'Suspend'); await dialogOpen(win);
  check('console: Suspend is a destructive confirmation that starts on Cancel', /Suspend UI Test Co/.test(await text(win, '#dlg-title')) && (await js(win, `document.getElementById('dlg-ok').classList.contains('btn-danger')`)) && await until(win, `document.activeElement && document.activeElement.id === 'dlg-cancel'`, 1500));
  await click(win, '#dlg-ok');
  check('console: the customer shows Suspended', await until(win, `/Suspended/.test(${rowSel('customers-tbody', 'UI Test Co')}.textContent)`));
  await clickIn(win, rowSel('customers-tbody', 'UI Test Co'), 'Enable'); await dialogOpen(win); await click(win, '#dlg-ok');
  check('console: and Active again after Enable', await until(win, `/Active/.test(${rowSel('customers-tbody', 'UI Test Co')}.textContent) && !/Suspended/.test(${rowSel('customers-tbody', 'UI Test Co')}.textContent)`));
  await clickIn(win, rowSel('customers-tbody', 'UI Test Co'), 'Reset password'); await dialogOpen(win); await click(win, '#dlg-ok');
  check('console: Reset password hands over a new one', await until(win, `getComputedStyle(document.getElementById('cust-cred-modal')).display !== 'none' && document.getElementById('cc-title').textContent === 'Password reset'`) && (await text(win, '#cc-pass')) !== newPass);
  await click(win, '#cc-done');
  await clickIn(win, rowSel('customers-tbody', 'UI Test Co'), 'Delete'); await dialogOpen(win);
  await key(win, '#dlg-cancel', 'Escape'); await dialogGone(win);
  check('console: Escape cancels a delete', !!(await js(win, `!!${rowSel('customers-tbody', 'UI Test Co')}`)));
  await clickIn(win, rowSel('customers-tbody', 'UI Test Co'), 'Delete'); await dialogOpen(win); await click(win, '#dlg-ok');
  check('console: confirming deletes the customer', await until(win, `!${rowSel('customers-tbody', 'UI Test Co')}`) && (await count(win, '#customers-tbody tr')) === 3);

  // names are text, never markup
  await fill(win, '#nc-name', '<img src=x onerror="window.__xss=1">Evil & Co'); await click(win, '#nc-create');
  await until(win, `getComputedStyle(document.getElementById('cust-cred-modal')).display !== 'none'`); await click(win, '#cc-done');
  await until(win, `!!${rowSel('customers-tbody', 'Evil')}`);
  check('security: a name with markup is shown as plain text, nothing executes', (await count(win, '#customers-tbody img')) === 0 && !(await js(win, `!!window.__xss`)) && /Evil & Co/.test(await js(win, `${rowSel('customers-tbody', 'Evil')}.textContent`)));
  await clickIn(win, rowSel('customers-tbody', 'Evil'), 'Delete'); await dialogOpen(win); await click(win, '#dlg-ok');
  await until(win, `!${rowSel('customers-tbody', 'Evil')}`);

  // releases
  await click(win, '[data-otab="releases"]'); await sleep(300);
  check('releases: the staged versions are shown per platform', /Windows 1\.4\.1/.test(await text(win, '#feed-version')) && /macOS — not staged/.test(await text(win, '#feed-version')));
  check('releases: every agent is listed with version and status', (await count(win, '#admin-agents-tbody tr')) === 7 && /Update available/.test(await js(win, `${rowSel('admin-agents-tbody', 'Warehouse-01')}.textContent`)));
  check('releases: "Push to all" stays locked until a canary is healthy', await js(win, `document.getElementById('push-all-btn').disabled`));
  check('releases: only an out-of-date online agent can be updated', !(await js(win, `Array.from(${rowSel('admin-agents-tbody', 'Warehouse-01')}.querySelectorAll('button')).find(b => b.textContent === 'Update').disabled`)) && await js(win, `Array.from(${rowSel('admin-agents-tbody', 'Reception-PC')}.querySelectorAll('button')).find(b => b.textContent === 'Update').disabled`));
  check('releases: version history is listed', (await count(win, '#versions-tbody tr')) >= 1 && /1\.4\.1/.test(await text(win, '#versions-tbody')));

  // branding
  await click(win, '[data-otab="branding"]'); await sleep(300);
  check('branding: shows the current product name', (await js(win, `document.getElementById('brand-name').value`)) === 'DeskLink');
  await fill(win, '#brand-name', 'AcmeAssist'); await click(win, '#brand-save'); await dialogOpen(win); await click(win, '#dlg-ok');
  check('branding: the console is renamed live', await until(win, `document.querySelector('.sidebar [data-brand]').textContent === 'AcmeAssist'`) && /AcmeAssist/.test(await js(win, `document.title`)));
  check('branding: the public endpoint serves the new name', ((await getJSON('/branding')) || {}).name === 'AcmeAssist');
  await fill(win, '#brand-name', 'DeskLink'); await click(win, '#brand-save'); await dialogOpen(win); await click(win, '#dlg-ok');
  check('branding: and can be changed back', await until(win, `document.querySelector('.sidebar [data-brand]').textContent === 'DeskLink'`));

  // ═════════════ 7. INSTALL + ACTIVITY ═════════════
  await nav(win, 'install');
  check('install: the three steps and the download link are shown', (await count(win, '#view-install .step')) === 3 && /\/download\.html$/.test(await text(win, '#copy-url')));
  await click(win, '#btn-copy');
  check('install: Copy gives feedback', await toast(win, '/copied/i'));
  await nav(win, 'activity');
  check('activity: the event log has the session and admin events', (await count(win, '#debug-logs div')) >= 8 && /Requesting connection to Reception-PC/.test(await text(win, '#debug-logs')));

  // ═════════════ 8. ACCOUNT, THEME, RELOAD, LOG OUT ═════════════
  await nav(win, 'account');
  check('account: shows who is signed in and the connection', /paras/.test(await text(win, '#acct-name')) && (await text(win, '#acct-conn')) === 'Connected' && !(await shown(win, '#acct-cid-row')));
  await click(win, '[data-theme-set="dark"]');
  check('theme: Dark applies immediately', (await js(win, `document.documentElement.dataset.theme`)) === 'dark' && (await js(win, `getComputedStyle(document.body).backgroundColor`)) !== 'rgb(244, 246, 251)');
  await win.webContents.reload(); await sleep(600);
  check('reload: the console resumes without asking for the password', await appShown(win, 7000) && !(await shown(win, '#login-form')));
  check('reload: the theme choice is remembered', (await js(win, `document.documentElement.dataset.theme`)) === 'dark');
  await nav(win, 'account'); await click(win, '[data-theme-set="light"]');
  check('theme: back to Light', (await js(win, `document.documentElement.dataset.theme`)) === 'light');
  await click(win, '#acct-logout'); await dialogOpen(win); await click(win, '#dlg-cancel'); await dialogGone(win);
  check('log out: Cancel stays signed in', await shown(win, '#app'));
  await click(win, '#logout-btn'); await dialogOpen(win); await click(win, '#dlg-ok');
  check('log out: returns to the sign-in page and clears the session', await loginShown(win) && !(await shown(win, '#app')) && !(await js(win, `sessionStorage.getItem('ts_agent_token')`)));
  await win.webContents.reload(); await sleep(700);
  check('log out: a reload does not sign back in', await loginShown(win) && !(await shown(win, '#app')));

  // ═════════════ 9. CUSTOMER ═════════════
  await signIn(win, CREDS.acme.username, CREDS.acme.password);
  check('customer: signs in', await appShown(win));
  check('customer: sees their Customer ID and role', (await text(win, '#cid-chip')) === 'TS-0001' && /Customer · TS-0001/.test(await text(win, '#user-role')) && /Acme/.test(await text(win, '#home-greeting')));
  check('customer: has Team, has no Owner Console', await shown(win, '.nav-item[data-open="team"]') && !(await shown(win, '.nav-item[data-open="admin"]')));
  await nav(win, 'agents');
  check('customer: sees only their own 5 machines', await until(win, `document.querySelectorAll('#agents-grid .agent-card').length === 5`) && !/Globex/.test(await text(win, '#agents-grid')));
  check('customer: no cross-customer details on the cards', (await count(win, '#agents-grid .ac-owner')) === 0);
  check('customer: cannot remove an installed machine (owner-only)', await js(win, `(function(){ const c = ${cardSel('Store-Backup')}; c.querySelector('.card-menu-btn').click(); const c2 = ${cardSel('Store-Backup')}; const b = Array.from(c2.querySelectorAll('.card-menu button')).find(b => b.textContent.trim() === 'Remove agent'); const r = !!b && b.disabled; document.body.click(); return r; })()`));
  await js(win, `openTab('admin'); true`); await sleep(250);
  check('customer: the Owner Console cannot be opened', (await view(win)) !== 'admin' || !(await shown(win, '#view-admin')));

  await nav(win, 'team');
  check('team: lists the 2 members and the seats in use', await until(win, `document.querySelectorAll('#team-tbody tr').length === 2`) && /2 of 5 seats used/.test(await text(win, '#team-quota-text')));
  await click(win, '#tm-create');
  check('team: an empty name is refused', await toast(win, "/Enter the team member/"));
  await fill(win, '#tm-name', 'UI Member'); await click(win, '#tm-create');
  check('team: creating a member shows their login and password (no Customer ID row)', await until(win, `getComputedStyle(document.getElementById('cust-cred-modal')).display !== 'none'`) && /^ts-0001-u\d+$/.test(await text(win, '#cc-login')) && !(await shown(win, '#cc-id')) && (await text(win, '#cc-pass')).length >= 8);
  const memberLogin = await text(win, '#cc-login'), memberPass = await text(win, '#cc-pass');
  await click(win, '#cc-done');
  check('team: the member is listed and the seat count goes up', await until(win, `document.querySelectorAll('#team-tbody tr').length === 3`) && await until(win, `/3 of 5 seats used/.test(document.getElementById('team-quota-text').textContent)`, 2500));

  // the member signs in elsewhere: shares the machines, cannot manage the team
  const win2 = makeWin(1280, 800, 'member');
  await win2.loadURL(BASE + '/dashboard'); await sleep(700);
  await js(win2, `window.DLTheme.set('light'); true`);
  await signIn(win2, memberLogin, memberPass);
  check('member: signs in with the handed-over login', await appShown(win2) && /Team member · TS-0001/.test(await text(win2, '#user-role')));
  await nav(win2, 'agents');
  check('member: sees the same organization machines', await until(win2, `document.querySelectorAll('#agents-grid .agent-card').length === 5`));
  check('member: has neither Team nor Owner Console', !(await shown(win2, '.nav-item[data-open="team"]')) && !(await shown(win2, '.nav-item[data-open="admin"]')));
  check('team: the owner sees the member online', await until(win, `/Online/.test(${rowSel('team-tbody', 'UI Member')}.textContent)`, 2500) || (await click(win, '.nav-item[data-open="team"]'), await until(win, `/Online/.test(${rowSel('team-tbody', 'UI Member')}.textContent)`, 2500)));

  // a teammate's session blocks others, and shows who has it
  await js(win2, `(${cardSel('Reception-PC')}).querySelector('.ac-foot .btn').click(); true`); await sleep(400);
  await nav(win, 'agents');
  check('team: a machine in a teammate\'s session shows who has it and offers no Connect', await until(win, `/In session — ${memberLogin}/.test((${cardSel('Reception-PC')}).querySelector('.status-pill').textContent)`, 3000) && !(await js(win, `!!(${cardSel('Reception-PC')}).querySelector('.ac-foot .btn')`)));

  // removing the member signs them out at once and frees the machine
  await nav(win, 'team');
  await clickIn(win, rowSel('team-tbody', 'UI Member'), 'Remove'); await dialogOpen(win); await click(win, '#dlg-ok');
  check('team: removing a member takes them off the list', await until(win, `document.querySelectorAll('#team-tbody tr').length === 2`) && await until(win, `/2 of 5 seats used/.test(document.getElementById('team-quota-text').textContent)`, 2500));
  check('member: is signed out immediately, with the reason', await loginShown(win2) && /access was removed/i.test(await text(win2, '#login-error') || ''));
  await nav(win, 'agents');
  check('team: the machine they were on is free again', await until(win, `(${cardSel('Reception-PC')}).querySelector('.status-pill').textContent.trim() === 'Available'`, 3000));

  // one console per login: a second sign-in signs the first out, visibly
  await signIn(win2, CREDS.acme.username, CREDS.acme.password);
  check('second sign-in: works in the new window', await appShown(win2));
  check('second sign-in: the first window is signed out and told why', await loginShown(win) && /another window or device/i.test(await text(win, '#login-error') || ''));
  win2.destroy();

  // a suspended customer gets a clear message
  await signIn(win, CREDS.initech.username, CREDS.initech.password);
  check('suspended: sign-in is refused with a clear message', await until(win, `/suspended/i.test(document.getElementById('login-error').textContent)`) && !(await shown(win, '#app')));
  win.destroy();

  // ═════════════ 10. NARROW WINDOW ═════════════
  win = makeWin(1000, 700, 'narrow');
  await win.loadURL(BASE + '/dashboard'); await sleep(700);
  await signIn(win, CREDS.globex.username, CREDS.globex.password);
  await appShown(win);
  check('narrow: the sidebar collapses to an icon rail and nothing overflows', (await js(win, `document.querySelector('.sidebar').getBoundingClientRect().width`)) <= 80 && (await js(win, `document.documentElement.scrollWidth <= window.innerWidth`)));
  await nav(win, 'agents');
  check('narrow: Globex sees exactly its 2 machines', await until(win, `document.querySelectorAll('#agents-grid .agent-card').length === 2`));
  win.destroy();

  // ═════════════ 11. PUBLIC PAGES ═════════════
  win = makeWin(1440, 900, 'public');
  await win.loadURL(BASE + '/'); await sleep(900);
  check('landing: hero, features, how-it-works, privacy, download and access sections exist', (await count(win, '.hero h1')) === 1 && (await count(win, '#features .feature')) === 6 && (await count(win, '#how .step')) === 3 && (await count(win, '#trust .consent-item')) === 3 && await shown(win, '#download') && await shown(win, '#access'));
  check('landing: Log in goes to the console, Download to the download section', (await js(win, `document.querySelector('.nav-cta .btn-ghost').getAttribute('href')`)) === '/dashboard' && (await js(win, `document.querySelector('.nav-cta .btn-primary').getAttribute('href')`)) === '#download');
  check('landing: detects Windows and highlights that download', await until(win, `document.getElementById('dl-win').classList.contains('suggested')`, 3000) && /Windows detected/.test(await text(win, '#os-note')));
  check('landing: the Windows button downloads, with the live version shown', (await js(win, `document.getElementById('win-btn').getAttribute('href')`)) === '/download/windows-zip' && /v1\.4\.1/.test(await text(win, '#win-meta')));
  check('landing: a Mac build that is not published yet is marked "Coming soon", not a dead link', (await js(win, `document.getElementById('mac-btn').getAttribute('aria-disabled')`)) === 'true' && !(await js(win, `document.getElementById('mac-btn').hasAttribute('href')`)) && /Coming soon/.test(await text(win, '#mac-badge')));
  check('landing: access is by email to support, no public sign-up', /support@techsarasolutions\.com/.test(await text(win, '#access')) && (await js(win, `document.querySelector('#access .mail').getAttribute('href')`)).startsWith('mailto:support@techsarasolutions.com'));
  check('landing: no horizontal overflow', await js(win, `document.documentElement.scrollWidth <= window.innerWidth`));
  await win.loadURL(BASE + '/download.html'); await sleep(800);
  check('download: Windows is preselected with a working button', await shown(win, '#pane-windows') && (await js(win, `document.getElementById('win-dl').getAttribute('href')`)) === '/download/windows-zip' && (await count(win, '#win-steps .step')) === 4);
  await click(win, '#tab-mac');
  check('download: the Mac tab explains it is coming soon', await shown(win, '#pane-mac') && await shown(win, '#mac-soon') && !(await shown(win, '#mac-steps')) && (await js(win, `document.getElementById('mac-dl').getAttribute('aria-disabled')`)) === 'true');
  check('download: tells the person they stay in control', /Disable Support Access/.test(await text(win, '.note')) && /uninstall/i.test(await text(win, '.note')));
  win.destroy();

  win = makeWin(390, 844, 'phone');
  await win.loadURL(BASE + '/'); await sleep(800);
  check('phone: landing fits the screen', await js(win, `document.documentElement.scrollWidth <= window.innerWidth`));
  await win.loadURL(BASE + '/download.html'); await sleep(600);
  check('phone: download page fits the screen', await js(win, `document.documentElement.scrollWidth <= window.innerWidth`));
  await win.loadURL(BASE + '/dashboard'); await sleep(600);
  check('phone: sign-in fits the screen and hides the brand panel', await js(win, `document.documentElement.scrollWidth <= window.innerWidth`) && !(await shown(win, '.auth-brand')) && await shown(win, '#login-form'));
  win.destroy();

  // ═════════════ 12. NOTHING WENT WRONG IN THE BROWSER ═════════════
  check('browser: no console errors, CSP violations or failed loads anywhere', logs.length === 0);
  if (logs.length) logs.slice(0, 20).forEach(l => console.log('   ' + l));

  const fails = R.filter(x => !x).length;
  console.log(`\n${R.length - fails}/${R.length} passed`);
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.error('UI E2E error:', e && e.stack || e); const fails = R.filter(x => !x).length; console.log(`\n(aborted) ${R.length - fails}/${R.length} passed before the error`); app.exit(1); });
