const socket = io();
const video  = document.getElementById('remote-video');

let peerConnection = null;
let dataChannel    = null;
let targetClientId = null;
let agentName      = '';
let agentRole      = 'support';
let currentOfferSender = null;   // the machine socket we are negotiating with
let pendingCandidates  = [];     // remote ICE candidates that arrived before the peer was ready

// Remote control toggles
let mouseEnabled    = true;
let keyboardEnabled = true;   // AUTO mode: routes by pointer position

// ICE servers come from the server (/ice) so the self-hosted TURN relay's
// short-lived credentials are always fresh. Fallback to public STUN only.
let iceConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ],
  iceCandidatePoolSize: 10
};

async function refreshIce() {
  try {
    const res = await fetch('/ice', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.iceServers) && data.iceServers.length) {
        iceConfig = { iceServers: data.iceServers, iceCandidatePoolSize: 10 };
        log('ICE servers loaded (' + data.iceServers.length + ' entries)');
      }
    }
  } catch (e) { log('ICE fetch failed — using STUN only'); }
}

/* ═══════════════ UI HELPERS ═══════════════ */
const $ = (id) => document.getElementById(id);

// Escape text before it goes into an innerHTML template. Names come from
// people (customers, team members, agents) — never trust them as markup.
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

const svgIcon = (paths, sw) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw || 2}" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const ICONS = {
  windows:  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 5.5 10.5 4.4v7.1H3zM11.6 4.2 21 3v8.5h-9.4zM3 12.5h7.5v7.1L3 18.5zM11.6 12.5H21V21l-9.4-1.3z"/></svg>',
  apple:    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 2.1c.1 1-.3 2-1 2.7-.7.8-1.8 1.4-2.8 1.3-.1-1 .4-2 1-2.7.8-.8 2-1.3 2.8-1.3zM19.3 17c-.5 1.2-.8 1.7-1.5 2.7-1 1.4-2.3 3.1-4 3.1-1.5 0-1.9-1-3.9-1-2 0-2.5 1-3.9 1-1.7 0-3-1.6-4-3C-.2 16-.6 11 1.6 8.3c1-1.3 2.6-2.1 4.1-2.1 1.6 0 2.6 1 3.9 1 1.3 0 2-1 3.9-1 1.4 0 2.9.8 3.9 2.1-3.4 1.9-2.9 6.8.9 8.7z"/></svg>',
  more:     '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>',
  pending:  svgIcon('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
  laptop:   svgIcon('<path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/>'),
  copy:     svgIcon('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  check:    svgIcon('<path d="M20 6 9 17l-5-5"/>', 2.8),
  x:        svgIcon('<path d="M18 6 6 18M6 6l12 12"/>', 2.8),
  info:     svgIcon('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>'),
  alert:    svgIcon('<path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/>'),
  connect:  svgIcon('<path d="M13 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3"/><path d="M8 21h8M12 17v4"/><path d="m17 8 5-5M17 3h5v5"/>'),
  power:    svgIcon('<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>'),
  swap:     svgIcon('<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>'),
  trash:    svgIcon('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>')
};

function initials(name) {
  const parts = String(name || '').trim().split(/[\s._-]+/).filter(Boolean);
  if (!parts.length) return '–';
  return (parts[0][0] + (parts.length > 1 ? parts[1][0] : (parts[0][1] || ''))).toUpperCase();
}

/* ── Toasts (non-blocking feedback; replaces alert()) ── */
function toast(message, type) {
  type = type || 'info';
  const stack = $('toast-stack');
  if (!stack) return;
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.innerHTML = `<span class="toast-ic">${type === 'success' ? ICONS.check : type === 'error' ? ICONS.x : ICONS.info}</span><span></span>`;
  t.lastElementChild.textContent = message;
  const close = () => {
    if (!t.isConnected) return;
    t.classList.add('out');
    setTimeout(() => t.remove(), 220);
  };
  t.addEventListener('click', close);
  stack.appendChild(t);
  while (stack.children.length > 4) stack.firstElementChild.remove();
  setTimeout(close, type === 'error' ? 6500 : 4200);
}

/* ── Confirm / prompt dialog (promise-based; replaces confirm()/prompt()) ── */
let dialogResolve = null;       // non-null while a dialog is open
let dialogCancelValue = false;

let dialogReturnFocus = null;   // what had focus before the dialog opened

function closeDialog(result) {
  $('ui-dialog').style.display = 'none';
  const resolve = dialogResolve;
  dialogResolve = null;
  const back = dialogReturnFocus;
  dialogReturnFocus = null;
  if (back && back.isConnected) { try { back.focus(); } catch (_) {} }
  if (resolve) resolve(result);
}

function openDialog(o) {
  if (dialogResolve) closeDialog(dialogCancelValue);     // one at a time
  dialogReturnFocus = document.activeElement;
  const tone = o.tone || 'primary';
  $('dlg-icon').className = 'dlg-icon tone-' + (tone === 'danger' ? 'danger' : tone === 'warning' ? 'warning' : 'primary');
  $('dlg-icon').innerHTML = tone === 'primary' ? ICONS.info : ICONS.alert;
  $('dlg-icon').firstElementChild.setAttribute('width', '20');
  $('dlg-icon').firstElementChild.setAttribute('height', '20');
  $('dlg-title').textContent = o.title || 'Are you sure?';
  $('dlg-msg').textContent = o.message || '';
  $('dlg-msg').style.display = o.message ? '' : 'none';
  const ok = $('dlg-ok');
  ok.textContent = o.confirmText || 'Confirm';
  ok.className = tone === 'danger' ? 'btn btn-danger solid' : 'btn btn-primary';
  $('dlg-cancel').textContent = o.cancelText || 'Cancel';
  const field = $('dlg-field'), input = $('dlg-input');
  field.style.display = o.input ? '' : 'none';
  if (o.input) {
    $('dlg-label').textContent = o.input.label || '';
    input.type = o.input.type || 'text';
    input.value = o.input.value == null ? '' : String(o.input.value);
    if (o.input.min != null) input.min = o.input.min; else input.removeAttribute('min');
    if (o.input.max != null) input.max = o.input.max; else input.removeAttribute('max');
  }
  dialogCancelValue = o.input ? null : false;
  $('ui-dialog').style.display = 'flex';
  // A destructive confirmation starts on Cancel, so a stray Enter is harmless.
  setTimeout(() => {
    if (o.input) { input.focus(); input.select(); }
    else (tone === 'danger' ? $('dlg-cancel') : ok).focus();
  }, 30);
  return new Promise((resolve) => { dialogResolve = resolve; });
}

function uiConfirm(title, message, opts) {
  return openDialog(Object.assign({ title, message }, opts || {}));
}
function uiPrompt(title, message, input, opts) {
  return openDialog(Object.assign({ title, message, input: input || {} }, opts || {}));
}

$('dlg-ok').addEventListener('click', () => closeDialog(dialogCancelValue === null ? $('dlg-input').value : true));
$('dlg-cancel').addEventListener('click', () => closeDialog(dialogCancelValue));
$('ui-dialog').addEventListener('click', (e) => { if (e.target === $('ui-dialog')) closeDialog(dialogCancelValue); });
$('ui-dialog').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeDialog(dialogCancelValue); }
  else if (e.key === 'Enter' && e.target !== $('dlg-cancel')) { e.preventDefault(); $('dlg-ok').click(); }
  else if (e.key === 'Tab') {
    // Keep keyboard focus inside the dialog while it is open.
    const f = Array.from($('ui-dialog').querySelectorAll('button, input'))
      .filter(el => !el.disabled && el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});
// Escape also closes the plain form modals. The one-time credentials sheet is
// deliberately excluded: it only closes with its own Done button.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || dialogResolve) return;
  if ($('create-agent-modal').style.display !== 'none') { e.preventDefault(); closeCreateAgentModal(); }
  else if ($('transfer-agent-modal').style.display !== 'none') { e.preventDefault(); closeTransferModal(); }
});

/* ── Clipboard ── */
function copyText(text, okMessage) {
  const done = () => { if (okMessage) toast(okMessage, 'success'); };
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); }
    catch (_) { toast('Could not copy — select the text and copy it manually', 'error'); }
    ta.remove();
  };
  if (navigator.clipboard && navigator.clipboard.writeText)
    return navigator.clipboard.writeText(text).then(done).catch(fallback);
  fallback();
}

/* ── Theme (light / dark / system — see theme.js) ── */
function syncThemeControls() {
  if (!window.DLTheme) return;
  const pref = window.DLTheme.get();
  document.querySelectorAll('[data-theme-set]').forEach(b => {
    const on = b.dataset.themeSet === pref;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}
document.querySelectorAll('[data-theme-toggle]').forEach(b => b.addEventListener('click', () => {
  if (!window.DLTheme) return;
  window.DLTheme.set(window.DLTheme.resolved() === 'dark' ? 'light' : 'dark');
  syncThemeControls();
}));
document.querySelectorAll('[data-theme-set]').forEach(b => b.addEventListener('click', () => {
  if (!window.DLTheme) return;
  window.DLTheme.set(b.dataset.themeSet);
  syncThemeControls();
}));
syncThemeControls();

/* ── Product name (the owner can rebrand it in the Owner Console) ── */
function applyConsoleBrand(name) {
  name = String(name || '').trim();
  if (!name) return;
  document.querySelectorAll('[data-brand]').forEach(el => { el.textContent = name; });
  document.title = name + ' Console';
}
fetch('/branding', { cache: 'no-store' })
  .then(r => (r.ok ? r.json() : null))
  .then(d => { if (d && d.name) applyConsoleBrand(d.name); })
  .catch(() => {});

/* ── Activity log (full log in Activity, last few events on Overview) ── */
const recentEvents = [];

function log(msg) {
  const now = new Date();
  const el = $('debug-logs');
  if (el) {
    const div = document.createElement('div');
    div.textContent = `> ${now.toLocaleTimeString()}: ${msg}`;
    el.appendChild(div);
    while (el.children.length > 500) el.firstElementChild.remove();
    el.scrollTop = el.scrollHeight;
  }
  recentEvents.push({ t: now, msg: String(msg) });
  if (recentEvents.length > 40) recentEvents.shift();
  renderHomeEvents();
}

function renderHomeEvents() {
  const box = $('home-events');
  if (!box || !recentEvents.length) return;
  box.innerHTML = recentEvents.slice(-6).reverse().map(e =>
    `<div class="event-row"><time>${esc(e.t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</time><span>${esc(e.msg)}</span></div>`
  ).join('');
}

/* ═══════════════ NAVIGATION ═══════════════
   The sidebar is the navigation. "Tabs" survive only as bookkeeping: openTabs
   remembers which sections were visited (so ending a session returns you to
   where you were) and whether a live session exists (its sidebar entry). */
const PAGE_META = {
  home:     ['Overview',      'Your fleet at a glance'],
  agents:   ['Agents',        'Every computer you can support'],
  session:  ['Live session',  'Remote screen and control'],
  activity: ['Activity',      'Live event log for this console'],
  install:  ['Install Agent', 'Add a new computer in three steps'],
  account:  ['My Account',    'Profile, appearance and session'],
  team:     ['Team',          'Logins for your support people'],
  admin:    ['Owner Console', 'Customers, releases and branding']
};
const TAB_TITLES = { session: 'Live session' };   // the session entry shows the client's name
let openTabs    = [];
let currentView = 'home';

// Collapse the sidebar to an icon rail during a session (the remote screen
// needs the room) and on narrow windows.
function updateRail() {
  const app = $('app');
  if (app) app.classList.toggle('rail', currentView === 'session' || window.innerWidth < 1100);
}
window.addEventListener('resize', updateRail);

// Sections a role does not have are not reachable, whatever asks for them
// (the server refuses their data and actions as well).
function allowedView(id) {
  if (id === 'admin' && agentRole !== 'admin') return 'home';
  if (id === 'team' && (agentRole === 'admin' || !agentIsTenantOwner)) return 'home';
  return id;
}

// Leaving the session view while fullscreen (with the keyboard locked) must
// release both — otherwise the Agents or sign-in page is left in a fullscreen
// window where Esc, Alt+Tab and the Windows key still do nothing.
function leaveFullscreen() {
  try { if (navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock(); } catch (_) {}
  if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (_) {} }
}

function showView(id) {
  id = allowedView(id);
  if (id !== 'session') leaveFullscreen();
  currentView = id;
  ['home', 'agents', 'session', 'activity', 'install', 'account', 'team', 'admin'].forEach(v => {
    const el = document.getElementById('view-' + v);
    if (el) el.style.display = (v === id) ? (v === 'agents' || v === 'session' ? 'flex' : 'block') : 'none';
  });
  const app = $('app');
  if (app) app.dataset.view = id;
  if (id === 'admin') { socket.emit('admin_list_users'); socket.emit('admin_feed_info'); socket.emit('admin_get_brand'); }
  if (id === 'team') socket.emit('team_list');
  renderTabs();
}

function openTab(id, title) {
  id = allowedView(id);
  if (title) TAB_TITLES[id] = title;
  if (!openTabs.includes(id)) openTabs.push(id);
  showView(id);
}

async function closeTab(id) {
  if (id === 'session' && targetClientId) {
    const ok = await uiConfirm('End this session?',
      'You will be disconnected from ' + targetClientId + '. The agent stays available for the next session.',
      { confirmText: 'End session', tone: 'danger' });
    if (!ok) return;
    endCurrentSession();
  }
  openTabs = openTabs.filter(t => t !== id);
  if (currentView === id) showView(openTabs.length ? openTabs[openTabs.length - 1] : 'home');
  else renderTabs();
}

// Syncs the sidebar, the page header and the live-session entry with the
// current view. (Keeps its old name — it is called from many places.)
function renderTabs() {
  document.querySelectorAll('.nav-item[data-open]').forEach(b =>
    b.classList.toggle('active', b.dataset.open === currentView));

  const navSession = $('nav-session');
  if (navSession) {
    navSession.style.display = openTabs.includes('session') ? '' : 'none';
    $('nav-session-title').textContent = TAB_TITLES.session || 'Live session';
    navSession.title = 'Live session — ' + (TAB_TITLES.session || '');
  }

  const meta = PAGE_META[currentView] || PAGE_META.home;
  $('page-title').textContent = meta[0];
  $('page-sub').textContent   = meta[1];
  updateRail();
}

$('btn-home').addEventListener('click', () => openTab('home'));
document.querySelectorAll('[data-open]').forEach(t =>
  t.addEventListener('click', () => openTab(t.dataset.open)));
$('nav-session-close').addEventListener('click', (e) => { e.stopPropagation(); closeTab('session'); });
$('bell-btn').addEventListener('click', () => {
  agentFilter = 'available';
  syncFilterButtons();
  openTab('agents');
  renderAgents();
});
// Overview KPI cards jump to the matching Agents filter.
document.querySelectorAll('[data-kpi]').forEach(k => k.addEventListener('click', () => {
  agentFilter = k.dataset.kpi === 'session' ? 'insession' : k.dataset.kpi;
  syncFilterButtons();
  openTab('agents');
  renderAgents();
}));

// Owner Console sub-sections
document.querySelectorAll('[data-otab]').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('[data-otab]').forEach(x => x.classList.toggle('active', x === b));
  document.querySelectorAll('[data-otab-panel]').forEach(p => { p.hidden = p.dataset.otabPanel !== b.dataset.otab; });
}));

// "/" focuses the agent search (never while steering a remote machine).
window.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (currentView === 'session' || $('app').style.display === 'none') return;
  const t = e.target, tag = t && t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
  e.preventDefault();
  $('home-search').focus();
});

/* ═══════════════ SERVER CONNECTION ═══════════════ */
const serverIndicator = document.getElementById('server-indicator');

socket.on('connect', () => {
  serverIndicator.classList.remove('offline');
  const conn = document.getElementById('acct-conn');
  if (conn) conn.textContent = 'Connected';
  log('Connected to server');
  // Re-register whenever the socket (re)connects — a server restart or network
  // blip wipes our support session server-side, so a silent re-login keeps the
  // dashboard working instead of leaving it connected-but-unregistered. It uses
  // the signed session token the server issued at sign-in; the password itself
  // is never kept in the browser.
  const savedName  = sessionStorage.getItem('ts_agent_name');
  const savedToken = sessionStorage.getItem('ts_agent_token');
  if (savedName && savedToken) {
    agentName = savedName;
    socket.emit('register', { type: 'support', username: savedName, token: savedToken });
  }
});

let serverBoot = null;   // identifies the server process we last signed in to
let lastDropAt = 0;      // when the connection to it was last lost

socket.on('disconnect', () => {
  lastDropAt = Date.now();
  serverIndicator.classList.add('offline');
  const conn = document.getElementById('acct-conn');
  if (conn) conn.textContent = 'Disconnected — reconnecting…';
  log('Disconnected from server');
});

/* ═══════════════ LOGIN / LOGOUT ═══════════════ */
let loginBusy  = false;
let loginTimer = null;

function showLoginError(msg) {
  const err = $('login-error');
  err.textContent = msg;
  err.style.display = 'block';
}

function setLoginBusy(busy) {
  loginBusy = busy;
  $('login-btn').classList.toggle('is-busy', busy);
  if (loginTimer) { clearTimeout(loginTimer); loginTimer = null; }
  if (busy) loginTimer = setTimeout(() => {
    setLoginBusy(false);
    showLoginError('The server did not respond. Check your connection and try again.');
  }, 12000);
}

// A real <form> so Enter works from either field and password managers can
// offer to fill / save the credentials.
$('login-form').addEventListener('submit', (e) => { e.preventDefault(); doLogin(); });
// Enable the submit button only now that the handler above is wired up — the
// button ships disabled so a script-less page can never native-POST the form.
$('login-btn').disabled = false;

// The pre-token console kept the password in sessionStorage — make sure a tab
// that was open across the upgrade does not leave one behind.
try { sessionStorage.removeItem('ts_agent_pwd'); } catch (_) {}

// A reload inside a signed-in tab resumes silently: keep the form out of sight
// for a moment instead of flashing it.
if (sessionStorage.getItem('ts_agent_token')) {
  $('login-screen').classList.add('resuming');
  setTimeout(() => $('login-screen').classList.remove('resuming'), 6000);
}

/* Show/hide password (eye toggle) */
function setPwdVisible(show) {
  const input = document.getElementById('admin-password');
  input.type = show ? 'text' : 'password';
  document.getElementById('eye-show').style.display = show ? 'none' : '';
  document.getElementById('eye-hide').style.display = show ? '' : 'none';
  document.getElementById('login-pwd-eye').title = show ? 'Hide password' : 'Show password';
}
document.getElementById('login-pwd-eye').addEventListener('click', () => {
  setPwdVisible(document.getElementById('admin-password').type === 'password');
});

function doLogin() {
  if (loginBusy) return;
  const name = $('admin-name').value.trim().toLowerCase();
  const pwd  = $('admin-password').value;
  $('login-error').style.display = 'none';
  if (!name || !pwd) return showLoginError('Enter your Customer ID (or username) and your password.');
  agentName = name;
  setLoginBusy(true);
  socket.emit('register', { type: 'support', username: name, password: pwd });
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

let agentCustomerId  = '';
let agentDisplayName = '';
let agentIsTenantOwner = false;
let agentTenantId    = '';
socket.on('login_success', (info) => {
  info = info || {};
  setLoginBusy(false);
  // The token is what persists the session now — don't leave the typed password
  // sitting in the DOM (readable via DevTools or any script) for the tab's life.
  $('admin-password').value = '';
  setPwdVisible(false);
  $('login-screen').classList.remove('resuming');
  agentRole = info.role || 'support';
  if (info.username) agentName = info.username;
  agentCustomerId  = info.customerId || '';
  agentDisplayName = info.displayName || '';
  agentIsTenantOwner = !!info.isTenantOwner;
  agentTenantId    = info.tenantId || agentCustomerId;
  const isAdmin = agentRole === 'admin';

  // Session token for silent re-login (reconnects, reloads in this tab).
  if (info.token) {
    sessionStorage.setItem('ts_agent_name', agentName);
    sessionStorage.setItem('ts_agent_token', info.token);
  }

  // A silent re-login after a reconnect must not yank the user back to Overview.
  const freshLogin = $('login-screen').style.display !== 'none';
  $('login-screen').style.display = 'none';
  $('app').style.display = 'flex';

  // Who is signed in: the owner by login; a customer by company name; a team
  // member by their own name — both of the latter tagged with the org's ID.
  const shownName = isAdmin ? agentName : (agentDisplayName || agentName);
  const roleLabel = isAdmin ? 'Product owner' : (agentIsTenantOwner ? 'Customer' : 'Team member');
  const orgId     = isAdmin ? '' : agentTenantId;
  $('user-name').textContent   = shownName;
  $('user-role').textContent   = roleLabel + (orgId ? ' · ' + orgId : '');
  $('user-avatar').textContent = initials(shownName);
  $('acct-avatar').textContent = initials(shownName);
  $('acct-name').textContent   = shownName;
  $('acct-role').textContent   = roleLabel;
  $('acct-login').textContent  = agentName;
  $('acct-cid').textContent    = orgId || '—';
  $('acct-cid-row').style.display = orgId ? '' : 'none';
  $('acct-server').textContent = window.location.origin;
  $('acct-conn').textContent   = 'Connected';
  $('copy-url').textContent    = window.location.origin + '/download.html';
  $('home-greeting').textContent = greeting() + ', ' + shownName.split(/\s+/)[0];

  // Organization ID chip in the header (customers and their team).
  const cidChip = $('cid-chip');
  cidChip.textContent = orgId;
  cidChip.style.display = orgId ? '' : 'none';

  // Show/hide owner-only UI
  document.querySelectorAll('.admin-only').forEach(el => el.style.display = isAdmin ? '' : 'none');
  // The Team feature is for a customer's main account (tenant owner) only —
  // not the product owner, not individual team members.
  const showTeam = !isAdmin && agentIsTenantOwner;
  document.querySelectorAll('.team-owner-only').forEach(el => el.style.display = showTeam ? '' : 'none');
  $('nav-org-label').style.display = (isAdmin || showTeam) ? '' : 'none';

  refreshIce();
  if (isAdmin) {
    socket.emit('list_support_users');   // owner-only on the server
    socket.emit('admin_list_users');     // customer count for the Overview
  }
  if (freshLogin) { openTabs = []; showView('home'); }
  else renderTabs();
  log('Signed in — welcome, ' + shownName + ' (' + roleLabel.toLowerCase() + (orgId ? ' ' + orgId : '') + ')');

  // After a silent re-login the server says which session it still has for
  // this console. When it has none for the machine on screen, either the
  // server just restarted (a deploy: ask for the session again, so it carries
  // on) or the session ended while this console was away (close it here too).
  const restarted = !!(serverBoot && info.boot && info.boot !== serverBoot);
  if (info.boot) serverBoot = info.boot;
  if (!freshLogin && targetClientId && 'session' in info && info.session !== targetClientId) {
    const machine = targetClientId;
    cleanupPeer();
    if (restarted && Date.now() - lastDropAt < 2 * 60 * 1000) {
      log('Server restarted — re-establishing the session with ' + machine + '…');
      setPlaceholder('Reconnecting to ' + machine + '…', 'Restoring the session');
      socket.emit('request_connection', machine);
    } else {
      log('The session with ' + machine + ' ended while this console was offline');
      toast('Your session with ' + machine + ' ended while this console was offline.', 'info');
      targetClientId = null;
      showPlaceholderUI();
      openTabs = openTabs.filter(t => t !== 'session');
      if (currentView === 'session') showView(openTabs.includes('agents') ? 'agents' : 'home');
      else renderTabs();
    }
  }
});

// Keep the sign-in fresh while the console stays open (see refresh_session).
socket.on('session_token', (d) => {
  if (d && d.token && sessionStorage.getItem('ts_agent_token')) sessionStorage.setItem('ts_agent_token', d.token);
});
setInterval(() => {
  if (socket.connected && sessionStorage.getItem('ts_agent_token')) socket.emit('refresh_session');
}, 6 * 60 * 60 * 1000);

socket.on('force_logout', (msg) => {
  hardLogout();
  showLoginError(msg || 'You were signed out.');
});

socket.on('login_error', (msg) => {
  setLoginBusy(false);
  $('login-screen').classList.remove('resuming');
  sessionStorage.removeItem('ts_agent_name');
  sessionStorage.removeItem('ts_agent_token');
  // If this failure came from a silent re-login while the app was open (e.g.
  // the account was removed, or the session token expired), the login screen
  // is hidden — writing into it would leave a zombie tab that looks connected
  // but is ignored by the server. Fall back to a full logout.
  if ($('app').style.display !== 'none') {
    hardLogout();
    showLoginError('Your session ended: ' + msg);
    return;
  }
  showLoginError(msg);
});

$('logout-btn').addEventListener('click', doLogout);
$('acct-logout').addEventListener('click', doLogout);

async function doLogout() {
  const ok = await uiConfirm('Log out?',
    targetClientId ? 'Your live session with ' + targetClientId + ' will be ended.'
                   : 'You will need to sign in again to use the console.',
    { confirmText: 'Log out' });
  if (!ok) return;
  log('Logging out...');
  socket.emit('agent_logout');
  hardLogout();
}

function hardLogout() {
  leaveFullscreen();
  cleanupPeer();
  closeCreateAgentModal();
  ['cust-cred-modal', 'transfer-agent-modal'].forEach(id => { $(id).style.display = 'none'; });
  if (dialogResolve) closeDialog(dialogCancelValue);
  targetClientId = null;
  sessionStorage.removeItem('ts_agent_name');
  sessionStorage.removeItem('ts_agent_token');
  openTabs = [];
  currentView = 'home';
  lastClients = [];
  // Wipe everything the previous account left on the page, so the next person
  // to sign in on this browser never sees their activity, data or searches.
  recentEvents.length = 0;
  supportUsers = [];
  agentFilter = 'all';
  agentSearch = '';
  ['debug-logs', 'home-events', 'customers-tbody', 'admin-agents-tbody', 'team-tbody'].forEach(id => { const el = $(id); if (el) el.innerHTML = ''; });
  ['cc-login', 'cc-pass', 'ca-code'].forEach(id => { const el = $(id); if (el) el.textContent = ''; });
  ['home-search', 'agents-search', 'nc-name'].forEach(id => { const el = $(id); if (el) el.value = ''; });
  $('app').style.display = 'none';
  $('login-screen').style.display = 'flex';
  $('login-screen').classList.remove('resuming');
  $('admin-password').value = '';
  setPwdVisible(false);
  $('login-error').style.display = 'none';
  setLoginBusy(false);
  agentName = '';
  agentRole = 'support';
  agentCustomerId = ''; agentDisplayName = ''; agentTenantId = ''; agentIsTenantOwner = false;
}

/* ═══════════════ OWNER CONSOLE ═══════════════ */
// Guard against a double-click / double-Enter creating two accounts (and losing
// the first one's one-time password): one request in flight at a time.
let ncBusy = false, ncTimer = null;
function setNcBusy(b) {
  ncBusy = b; $('nc-create').disabled = b;
  if (ncTimer) { clearTimeout(ncTimer); ncTimer = null; }   // a stale fallback must not drop a later guard
}
$('nc-create').addEventListener('click', () => {
  if (ncBusy) return;
  const displayName = $('nc-name').value.trim();
  if (displayName.length < 2) { $('nc-name').focus(); return adminMsg('Enter the customer / company name', true); }
  const teamLimit = parseInt($('nc-limit').value, 10);
  setNcBusy(true);
  ncTimer = setTimeout(() => setNcBusy(false), 8000);   // fallback if the server never answers
  socket.emit('admin_create_customer', { displayName, teamLimit: Number.isFinite(teamLimit) ? teamLimit : 5 });
});

/* ── App branding ── */
socket.on('admin_brand', (d) => {
  if (!d || !d.name) return;
  $('brand-name').value = d.name;
  applyConsoleBrand(d.name);
});
$('brand-save').addEventListener('click', async () => {
  const name = $('brand-name').value.trim();
  if (name.length < 2) { $('brand-name').focus(); return adminMsg('Enter a product name (2-40 characters)', true); }
  const ok = await uiConfirm('Rename the product?',
    'Every online agent switches to "' + name + '" immediately; the rest pick it up when they next connect.',
    { confirmText: 'Save & push' });
  if (ok) socket.emit('admin_set_brand', { name });
});
$('nc-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.repeat) $('nc-create').click();
});

function adminMsg(text, isError) { toast(text, isError ? 'error' : 'success'); }

socket.on('admin_error', (msg) => { setNcBusy(false); adminMsg(msg, true); });
socket.on('admin_ok', (msg) => {
  setNcBusy(false);
  adminMsg(msg, false);
  $('nc-name').value = '';
});

// Show the one-time credentials modal (after create OR password reset).
function showCredModal(title, sub, d, opts) {
  opts = opts || {};
  document.getElementById('cc-title').textContent = title;
  document.getElementById('cc-sub').textContent   = sub;
  document.getElementById('cc-id').textContent    = d.customerId || '—';
  document.getElementById('cc-login').textContent = d.username || (d.customerId || '').toLowerCase();
  document.getElementById('cc-pass').textContent  = d.password || '—';
  document.getElementById('cc-url').textContent   = window.location.origin + '/dashboard';
  // Team members have a login but no Customer ID — hide that row for them.
  const idRow = document.getElementById('cc-id').closest('.cc-row');
  if (idRow) idRow.style.display = opts.hideId ? 'none' : '';
  document.getElementById('cust-cred-modal').style.display = 'flex';
}
socket.on('customer_created', (d) => {
  setNcBusy(false);
  socket.emit('list_support_users');   // keep card labels + the reassign picker current
  showCredModal('Customer created', 'Hand these details to the customer. The password is shown only once — copy it now.', d);
});
socket.on('password_reset_ok', (d) => {
  showCredModal('Password reset', 'Give the customer their new password. It is shown only once.', d);
});
$('cc-copy').addEventListener('click', () => {
  const idRow = $('cc-id').closest('.cc-row');
  const showId = !idRow || idRow.style.display !== 'none';
  const brand = (document.querySelector('[data-brand]') || {}).textContent || 'DeskLink';
  const txt = brand + ' console access\n'
    + 'Console: ' + $('cc-url').textContent + '\n'
    + (showId ? 'Customer ID: ' + $('cc-id').textContent + '\n' : '')
    + 'Login: ' + $('cc-login').textContent + '\n'
    + 'Password: ' + $('cc-pass').textContent;
  copyText(txt, 'Access details copied');
});
// per-row copy buttons in the credentials modal
document.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () => {
  copyText($(b.dataset.copy).textContent, 'Copied');
}));

/* ═══════════════ TEAM (customer's support people) ═══════════════ */
function teamMsg(text, isError) { toast(text, isError ? 'error' : 'success'); }

let tmBusy = false, teamFull = false, tmTimer = null;
function setTmBusy(b) {
  tmBusy = b; $('tm-create').disabled = b || teamFull;
  if (tmTimer) { clearTimeout(tmTimer); tmTimer = null; }
}
$('tm-create').addEventListener('click', () => {
  if (tmBusy || teamFull) return;
  const displayName = $('tm-name').value.trim();
  if (displayName.length < 2) { $('tm-name').focus(); return teamMsg('Enter the team member\'s name', true); }
  setTmBusy(true);
  tmTimer = setTimeout(() => setTmBusy(false), 8000);
  socket.emit('team_create', { displayName });
});

// Seats used vs. the limit the product owner set for this organization.
socket.on('team_quota', (q) => {
  if (!q) return;
  const used = Number(q.used) || 0, limit = Number(q.limit) || 0;
  const full = used >= limit;
  $('team-quota').style.display = '';
  $('team-quota-text').textContent = limit === 0 ? 'Team members not included'
    : used + ' of ' + limit + ' seat' + (limit === 1 ? '' : 's') + ' used';
  const bar = $('team-quota-bar');
  bar.classList.toggle('full', full);
  bar.firstElementChild.style.width = (limit ? Math.min(100, Math.round(used / limit * 100)) : 100) + '%';
  teamFull = full;
  $('tm-create').disabled = full || tmBusy;
  $('tm-create').title = full ? 'Team member limit reached — contact support to increase it' : '';
});
document.getElementById('tm-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.repeat) document.getElementById('tm-create').click();
});
socket.on('team_error', (msg) => { setTmBusy(false); teamMsg(msg, true); });
socket.on('team_ok', (msg) => teamMsg(msg, false));
socket.on('team_member_created', (d) => {
  setTmBusy(false);
  document.getElementById('tm-name').value = '';
  showCredModal('Team member login created',
    'Give these to your team member. The password is shown only once — copy it now.',
    { username: d.username, password: d.password }, { hideId: true });
});
socket.on('team_password_reset', (d) => {
  showCredModal('Password reset',
    'Give your team member their new password. It is shown only once.',
    { username: d.username, password: d.password }, { hideId: true });
});
socket.on('team_list', (members) => {
  const tb = $('team-tbody');
  if (!tb) return;
  tb.innerHTML = '';
  const others = (members || []).filter(m => !m.isTenantOwner);  // don't list the owner's own account
  if (!others.length) {
    tb.innerHTML = '<tr><td colspan="4" class="empty">No team members yet. Add one above so your colleagues get their own login.</td></tr>';
    return;
  }
  others.forEach(m => {
    const label = m.displayName || m.username;
    const tr = document.createElement('tr');
    const status = m.suspended ? '<span class="pill danger">Suspended</span>'
                 : m.online    ? '<span class="pill ok">Online</span>'
                 :               '<span class="pill">Offline</span>';
    tr.innerHTML = `<td class="cell-strong">${esc(label)}</td><td><span class="cell-id">${esc(m.username)}</span></td><td>${status}</td><td class="actions"></td>`;
    const cell = tr.lastElementChild;
    const rst = document.createElement('button');
    rst.className = 'tbl-btn'; rst.textContent = 'Reset password';
    rst.addEventListener('click', async () => {
      const ok = await uiConfirm('Reset password?',
        label + ' will be signed out and will need the new password you are given.',
        { confirmText: 'Reset password' });
      if (ok) socket.emit('team_reset_password', { username: m.username });
    });
    cell.appendChild(rst);
    const del = document.createElement('button');
    del.className = 'tbl-del'; del.textContent = 'Remove';
    del.addEventListener('click', async () => {
      const ok = await uiConfirm('Remove team member?',
        label + '\'s login stops working immediately. Your agents are not affected.',
        { confirmText: 'Remove', tone: 'danger' });
      if (ok) socket.emit('team_remove', { username: m.username });
    });
    cell.appendChild(del);
    tb.appendChild(tr);
  });
});
// The password in this sheet is shown once: it closes only with Done, never by
// a stray click on the backdrop.
$('cc-done').addEventListener('click', () => { $('cust-cred-modal').style.display = 'none'; });

socket.on('admin_users', (list) => {
  const tb = $('customers-tbody');
  if (!tb) return;
  tb.innerHTML = '';
  // Customers are the tenant-OWNER support accounts; team members are managed
  // by the customer, not shown here.
  const customers = list.filter(u => u.role !== 'admin' && u.isTenantOwner);
  const suspended = customers.filter(u => u.suspended).length;
  const teamLogins = customers.reduce((n, u) => n + (u.teamCount || 0), 0);
  $('os-customers').textContent  = customers.length;
  $('os-team').textContent       = teamLogins;
  $('kpi-customers').textContent = customers.length;
  $('kpi-customers-foot').textContent = suspended ? suspended + ' suspended' : 'all active';

  if (!customers.length) {
    tb.innerHTML = '<tr><td colspan="6" class="empty">No customers yet. Add your first one above.</td></tr>';
  }
  customers.forEach(u => {
    const label = u.displayName || u.customerId || u.username;
    const tr = document.createElement('tr');
    const statusPill = u.suspended
      ? '<span class="pill danger">Suspended</span>'
      : '<span class="pill ok">Active</span>';
    const used = u.teamCount || 0, lim = (u.teamLimit === undefined ? 5 : u.teamLimit);
    tr.innerHTML =
      `<td><span class="cell-id">${esc(u.customerId || '—')}</span></td>` +
      `<td class="cell-strong">${esc(u.displayName || u.username)}</td>` +
      `<td>${statusPill}</td>` +
      `<td class="tnum">${u.agentCount || 0}</td>` +
      `<td class="tnum" style="white-space:nowrap;">${used} / ${lim}<button class="tbl-btn" data-limit="1">Edit</button></td>` +
      `<td class="actions"></td>`;

    tr.querySelector('button[data-limit]').addEventListener('click', async () => {
      const v = await uiPrompt('Team member limit',
        'How many extra support logins may ' + label + ' create for their own staff? Use 0 for none.',
        { label: 'Limit', type: 'number', value: lim, min: 0, max: 1000 },
        { confirmText: 'Save limit' });
      if (v === null) return;
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n < 0) return toast('Enter a number 0 or greater.', 'error');
      socket.emit('admin_set_team_limit', { username: u.username, teamLimit: n });
    });
    const cell = tr.lastElementChild;

    const sus = document.createElement('button');
    sus.className = 'tbl-btn';
    sus.textContent = u.suspended ? 'Enable' : 'Suspend';
    sus.title = u.suspended ? 'Re-enable this customer\'s login' : 'Block this customer from signing in';
    sus.addEventListener('click', async () => {
      const ok = u.suspended
        ? await uiConfirm('Re-enable ' + label + '?', 'They and their team will be able to sign in again.', { confirmText: 'Enable' })
        : await uiConfirm('Suspend ' + label + '?',
            'They and their whole team are signed out and blocked until you re-enable them. Their agents are kept.',
            { confirmText: 'Suspend', tone: 'danger' });
      if (ok) socket.emit('admin_suspend_user', { username: u.username, suspended: !u.suspended });
    });
    cell.appendChild(sus);

    const rst = document.createElement('button');
    rst.className = 'tbl-btn';
    rst.textContent = 'Reset password';
    rst.addEventListener('click', async () => {
      const ok = await uiConfirm('Reset password for ' + label + '?',
        'A new password is generated for you to hand over, and the customer is signed out.',
        { confirmText: 'Reset password' });
      if (ok) socket.emit('admin_reset_password', { username: u.username });
    });
    cell.appendChild(rst);

    const del = document.createElement('button');
    del.className = 'tbl-del';
    del.textContent = 'Delete';
    del.title = 'Delete this customer and their team';
    del.addEventListener('click', async () => {
      const ok = await uiConfirm('Delete ' + label + '?',
        'This permanently removes the customer and all of their team logins. Their agents are reassigned to you. This cannot be undone.',
        { confirmText: 'Delete customer', tone: 'danger' });
      if (ok) socket.emit('admin_delete_user', { username: u.username });
    });
    cell.appendChild(del);
    tb.appendChild(tr);
  });
  renderAdminAgents();
});

function renderAdminAgents() {
  const tb = $('admin-agents-tbody');
  if (!tb) return;
  tb.innerHTML = '';
  $('os-agents').textContent = lastClients.length;
  if (!lastClients.length) {
    tb.innerHTML = '<tr><td colspan="4" class="empty">No agents registered yet.</td></tr>';
    return;
  }
  lastClients.forEach(c => {
    const tr = document.createElement('tr');
    const status = c.pending ? `<span class="pill warn">To install</span> <span class="mono small muted">${esc(c.installCode || '')}</span>`
                 : c.online  ? `<span class="pill ok">Online</span>${c.available ? '' : ' <span class="pill">Access off</span>'}`
                 :             '<span class="pill">Offline</span>';
    const ver = c.pending ? '<span class="muted">—</span>'
              : `<span class="mono small">${esc(c.version || 'unknown')}</span>`
                + ` <span class="muted small">${c.platform === 'mac' ? 'macOS' : 'Windows'}</span>`
                + (c.updateAvailable ? ' <span class="pill info plain">Update available</span>' : '');
    tr.innerHTML = `<td class="cell-strong">${esc(c.id)}</td><td>${ver}</td><td>${status}</td><td class="actions"></td>`;
    const cell = tr.lastElementChild;

    const upd = document.createElement('button');
    upd.className = 'tbl-btn';
    upd.textContent = 'Update';
    upd.disabled = !c.online || c.isBusy || !c.updateAvailable;
    upd.title = !c.online ? 'Agent must be online'
              : c.isBusy ? 'Cannot update an in-session agent'
              : !c.updateAvailable ? 'Already on the staged version' : 'Push update to this agent (canary)';
    upd.addEventListener('click', async () => {
      const ok = await uiConfirm('Update ' + c.id + ' now?',
        'It installs the staged version and restarts. When it reports back healthy, "Push update to all" unlocks.',
        { confirmText: 'Push update' });
      if (ok) socket.emit('admin_push_update_one', c.id);
    });
    cell.appendChild(upd);

    const del = document.createElement('button');
    del.className = 'tbl-del';
    del.textContent = 'Delete';
    del.disabled = c.isBusy;
    del.title = c.isBusy ? 'Cannot delete an in-session agent' : 'Remove this agent permanently';
    del.addEventListener('click', async () => {
      const ok = await uiConfirm('Delete agent ' + c.id + '?',
        'It disappears from every dashboard and the computer must be set up again with a new installation code.',
        { confirmText: 'Delete agent', tone: 'danger' });
      if (ok) socket.emit('remove_client', c.id);
    });
    cell.appendChild(del);
    tb.appendChild(tr);
  });
}

/* ── Rollout: push-to-all, reset, canary unlock, version history/rollback ── */
$('push-all-btn').addEventListener('click', async () => {
  const ok = await uiConfirm('Push the update to all agents?',
    'Every online, idle agent on a canary-cleared platform installs the staged version now. Agents in a live session are skipped.',
    { confirmText: 'Push to all', tone: 'warning' });
  if (ok) socket.emit('admin_push_update_all');
});
$('reset-rollout-btn').addEventListener('click', () => socket.emit('admin_reset_rollout'));

socket.on('canary_healthy', (d) => {
  const btn = document.getElementById('push-all-btn');
  btn.disabled = false;
  btn.title = 'Canary healthy — safe to push to all';
  adminMsg('Canary ' + d.clientId + ' is healthy on ' + d.version + ' — "Push to ALL" unlocked', false);
});

let feedActiveVersion = null;
socket.on('admin_feed', (info) => {
  feedActiveVersion = info.active;
  // Two independent feeds since mac support: Windows (latest.yml) and macOS
  // (latest-mac.yml). Each agent updates against its own platform's feed.
  const parts = [];
  parts.push('Windows ' + (info.active || '— not staged'));
  parts.push('macOS ' + (info.activeMac || '— not staged'));
  $('feed-version').textContent =
    parts.join('  ·  ') + (info.rollbackMode ? '  (rollback mode)' : '');
  const btn = $('push-all-btn');
  btn.disabled = !info.canaryHealthy;
  // Per-platform: the button unlocks when EITHER platform has a healthy canary,
  // and the server only pushes to the platform(s) that are cleared.
  const cleared = [];
  if (info.canaryHealthyWin) cleared.push('Windows');
  if (info.canaryHealthyMac) cleared.push('macOS');
  btn.title = cleared.length
    ? 'Canary healthy for ' + cleared.join(' & ') + ' — pushes only to cleared platform(s)'
    : 'Push a canary agent first (per platform)';

  const tb = document.getElementById('versions-tbody');
  tb.innerHTML = '';
  (info.versions || []).forEach(v => {
    const tr = document.createElement('tr');
    const isActive = v === info.active || v === info.activeMac;
    const servingTag = v === info.active && v === info.activeMac ? 'serving now'
                     : v === info.active ? 'serving now (Windows)'
                     : v === info.activeMac ? 'serving now (macOS)' : '';
    tr.innerHTML = `<td><span class="mono cell-strong">${esc(v)}</span>${isActive ? ' <span class="pill ok">' + esc(servingTag) + '</span>' : ''}</td><td></td><td class="actions"></td>`;
    if (!isActive) {
      const act = document.createElement('button');
      act.className = 'tbl-btn';
      act.textContent = 'Serve this version';
      act.title = 'Make this version the staged feed, then push it to agents';
      act.addEventListener('click', async () => {
        const ok = await uiConfirm('Serve version ' + v + '?',
          'It becomes the staged release. Nothing installs until you push it — canary first, then everyone.',
          { confirmText: 'Serve ' + v, tone: 'warning' });
        if (ok) socket.emit('admin_activate_version', v);
      });
      tr.lastElementChild.appendChild(act);
    }
    tb.appendChild(tr);
  });
  if (!(info.versions || []).length) tb.innerHTML = '<tr><td colspan="3" class="empty">No versions archived yet.</td></tr>';
});

socket.on('logout_ok', () => log('Server confirmed logout'));

/* ═══════════════ AGENT LIST ═══════════════ */
let lastClients = [];
let agentFilter = 'all';
let agentSearch = '';
let openMenuFor = null;

function classify(c) {
  if (c.pending) return 'toinstall';
  if (!c.online) return 'offline';
  if (c.isBusy)  return (c.agentName === agentName) ? 'mine' : 'busy';
  if (c.available) return 'available';
  return 'unavailable';
}

socket.on('clients_list', (clients) => {
  lastClients = clients;
  if (refreshPending) { refreshPending = false; toast('Agent list is up to date', 'success'); }
  renderAgents();
  updateBell();
  if (currentView === 'admin') renderAdminAgents();
});

socket.on('deleted_by_admin', () => {});  // (dashboard side ignores; client handles it)

function updateBell() {
  const n = lastClients.filter(c => classify(c) === 'available').length;
  const b = document.getElementById('bell-badge');
  b.textContent = n;
  b.style.display = n > 0 ? 'flex' : 'none';
}

function syncFilterButtons() {
  document.querySelectorAll('.side-filter').forEach(f =>
    f.classList.toggle('active', f.dataset.filter === agentFilter));
}

document.querySelectorAll('.side-filter').forEach(f => {
  f.addEventListener('click', () => {
    agentFilter = f.dataset.filter;
    syncFilterButtons();
    renderAgents();
  });
});

document.getElementById('agents-search').addEventListener('input', (e) => {
  agentSearch = e.target.value.trim().toLowerCase();
  renderAgents();
});

// Refresh asks the server for the list again (it also arrives by itself
// whenever anything changes).
let refreshPending = false;
$('agents-refresh').addEventListener('click', () => {
  if (!socket.connected) return toast('Not connected to the server — reconnecting…', 'error');
  refreshPending = true;
  socket.emit('list_clients');
  setTimeout(() => { if (refreshPending) { refreshPending = false; renderAgents(); } }, 4000);
});
// Every "add an agent" entry point opens the same dialog.
['agents-add', 'agents-empty-add', 'qa-add', 'qa-add-top', 'install-create'].forEach(id => {
  const b = $(id);
  if (b) b.addEventListener('click', openCreateAgentModal);
});

/* ═══════════════ CREATE AGENT (installation code) ═══════════════ */
function openCreateAgentModal() {
  document.getElementById('ca-step1').style.display = '';
  document.getElementById('ca-step2').style.display = 'none';
  document.getElementById('ca-name').value = '';
  document.getElementById('ca-error').style.display = 'none';
  document.getElementById('create-agent-modal').style.display = 'flex';
  document.getElementById('ca-name').focus();
}

function closeCreateAgentModal() {
  document.getElementById('create-agent-modal').style.display = 'none';
}

function submitCreateAgent() {
  const name = document.getElementById('ca-name').value.trim();
  const err  = document.getElementById('ca-error');
  if (name.length < 2) {
    err.textContent = 'Enter an agent name (at least 2 characters).';
    err.style.display = 'block';
    return;
  }
  socket.emit('create_agent_slot', { name });
}

document.getElementById('ca-create').addEventListener('click', submitCreateAgent);
document.getElementById('ca-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitCreateAgent(); });
document.getElementById('ca-cancel').addEventListener('click', closeCreateAgentModal);
document.getElementById('ca-done').addEventListener('click', closeCreateAgentModal);
document.getElementById('create-agent-modal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('create-agent-modal')) closeCreateAgentModal();
});

socket.on('agent_slot_created', (d) => {
  document.getElementById('ca-step1').style.display = 'none';
  document.getElementById('ca-step2').style.display = '';
  document.getElementById('ca-created-name').textContent = d.name;
  document.getElementById('ca-code').textContent = d.code;
  document.getElementById('ca-dl-link').textContent = window.location.origin + '/download.html';
  log('Agent "' + d.name + '" created — installation code ' + d.code);
});

socket.on('agent_slot_error', (msg) => {
  const err = document.getElementById('ca-error');
  err.textContent = msg;
  err.style.display = 'block';
});

$('ca-copy-code').addEventListener('click', () => {
  copyText($('ca-code').textContent, 'Installation code copied');
});

/* ═══════════════ TRANSFER AGENT ═══════════════ */
// Hand a machine to another support user. It leaves this dashboard and appears
// in theirs. (The other route is on the machine itself: "change code", using an
// installation code issued by the new owner.)
let supportUsers   = [];
let transferAgent  = null;

socket.on('support_users', (list) => {
  supportUsers = Array.isArray(list) ? list : [];
  renderAgents();   // owner view labels each agent with its customer
  if (transferAgent) fillTransferOptions();   // a refresh while the reassign dialog is open rebuilds it
});

// Build (or rebuild) the reassign picker from the current customer list,
// keeping the current selection. Called on open and whenever support_users
// arrives while the dialog is open, so a customer added meanwhile shows up.
function fillTransferOptions() {
  const c = transferAgent;
  if (!c) return;
  const sel = document.getElementById('tr-user');
  const prev = sel.value;
  sel.innerHTML = '';
  // Only other customers are valid reassignment targets (not the owner).
  const others = supportUsers.filter(u => u.username !== (c.owner || '') && u.role !== 'admin');
  others.forEach(u => {
    const o = document.createElement('option');
    o.value = u.username;
    o.textContent = (u.displayName || u.username) + (u.customerId ? ' (' + u.customerId + ')' : '');
    sel.appendChild(o);
  });
  if (prev && others.some(u => u.username === prev)) sel.value = prev;
  const err = document.getElementById('tr-error');
  document.getElementById('tr-confirm').disabled = others.length === 0;
  if (!others.length) {
    err.textContent = 'No other customer to reassign to. Add one in the Owner Console first.';
    err.style.display = 'block';
  } else {
    err.style.display = 'none';
  }
}

function openTransferModal(c) {
  transferAgent = c;
  socket.emit('list_support_users');          // refresh in case a user was added
  document.getElementById('tr-agent-name').textContent = c.id;
  document.getElementById('tr-current').textContent    = c.owner || 'nobody';
  document.getElementById('tr-error').style.display = 'none';
  fillTransferOptions();
  document.getElementById('tr-busy').style.display = c.isBusy ? 'block' : 'none';
  document.getElementById('transfer-agent-modal').style.display = 'flex';
}

function closeTransferModal() {
  document.getElementById('transfer-agent-modal').style.display = 'none';
  transferAgent = null;
}

document.getElementById('tr-confirm').addEventListener('click', () => {
  if (!transferAgent) return;
  const to = document.getElementById('tr-user').value;
  if (!to) return;
  socket.emit('transfer_agent', { clientId: transferAgent.id, to });
});
document.getElementById('tr-cancel').addEventListener('click', closeTransferModal);
document.getElementById('transfer-agent-modal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('transfer-agent-modal')) closeTransferModal();
});

socket.on('agent_transfer_ok', (d) => {
  closeTransferModal();
  log('Transferred ' + d.clientId + ' to ' + d.to);
  // If we were in a session with it, the server has just ended that session.
  if (targetClientId === d.clientId) {
    cleanupPeer();
    targetClientId = null;
    openTabs = openTabs.filter(t => t !== 'session');
    showPlaceholderUI();
    showView(openTabs.includes('agents') ? 'agents' : 'home');
  }
});

socket.on('agent_transfer_error', (msg) => {
  const err = document.getElementById('tr-error');
  err.textContent = msg;
  err.style.display = 'block';
});

/* ── Dashboard enable/disable of an agent's support access ── */
socket.on('agent_availability_ok', (d) => {
  log(d.clientId + ' is now ' + (d.available ? 'Active (support access enabled)' : 'Inactive (support access disabled)'));
  toast('Support access turned ' + (d.available ? 'on' : 'off') + ' for ' + d.clientId, 'success');
});
socket.on('agent_availability_error', (msg) => {
  log('Could not change availability: ' + msg);
  toast('Could not change support access: ' + msg, 'error');
});

const homeSearch = document.getElementById('home-search');
homeSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    agentSearch = homeSearch.value.trim().toLowerCase();
    document.getElementById('agents-search').value = homeSearch.value.trim();
    agentFilter = 'all';
    syncFilterButtons();
    openTab('agents');
    renderAgents();
  }
});

document.addEventListener('click', () => {
  if (openMenuFor !== null) { openMenuFor = null; renderAgents(); }
});

const STATUS_TEXT = {
  available:   'Available',
  unavailable: 'Access off',
  offline:     'Offline',
  mine:        'In session with you',
  busy:        'In session',
  toinstall:   'To install'
};
const STATUS_HINT = {
  available:   'Ready — click to connect',
  unavailable: 'Online, but support access is turned off. Turn it on from the ⋮ menu or in the app.',
  offline:     'The computer is off or asleep — it reconnects by itself when it is back',
  mine:        'Click to return to your session',
  busy:        'Another support person is connected',
  toinstall:   'Share this code — the app asks for it on first launch'
};
const STATUS_NOTE = {
  unavailable: 'Support access is off',
  offline:     'Reconnects automatically',
  toinstall:   'Waiting for the code'
};

function platformName(c) { return c.platform === 'mac' ? 'macOS' : 'Windows'; }
function platformIcon(c) { return c.platform === 'mac' ? ICONS.apple : ICONS.windows; }
function agentSubtitle(c) {
  if (c.pending) return 'Awaiting installation';
  const v = (c.version && c.version !== 'unknown') ? ' · v' + c.version : '';
  return platformName(c) + v;
}

// Owner view only: which customer an agent belongs to.
function customerLabel(c) {
  const byTenant = supportUsers.find(u => u.customerId && u.customerId === c.tenantId);
  if (byTenant) return (byTenant.displayName || byTenant.username) + ' · ' + byTenant.customerId;
  if (c.owner === agentName) return 'Not assigned yet';
  return c.owner || 'Not assigned yet';
}

function openOrConnect(c) {
  if (targetClientId === c.id) { openTab('session', tabTitleFor(c.id)); return; }
  connectToClient(c.id);
}

function sizeIcon(el, px) {
  const s = el.querySelector('svg');
  if (s) { s.setAttribute('width', px); s.setAttribute('height', px); }
}

function renderAgents() {
  const grid  = $('agents-grid');
  const empty = $('agents-empty');

  const counts = { all: lastClients.length, available: 0, unavailable: 0, offline: 0, toinstall: 0, insession: 0, online: 0 };
  lastClients.forEach(c => {
    const s = classify(c);
    if (c.online && !c.pending) counts.online++;
    if (s === 'available') counts.available++;
    else if (s === 'unavailable') counts.unavailable++;
    else if (s === 'offline') counts.offline++;
    else if (s === 'toinstall') counts.toinstall++;
    else if (s === 'mine' || s === 'busy') counts.insession++;
  });
  $('count-all').textContent         = counts.all || '';
  $('count-available').textContent   = counts.available || '';
  $('count-insession').textContent   = counts.insession || '';
  $('count-unavailable').textContent = counts.unavailable || '';
  $('count-offline').textContent     = counts.offline || '';
  $('count-toinstall').textContent   = counts.toinstall || '';
  $('nav-count-agents').textContent  = counts.all || '';
  renderOverview(counts);

  let list = lastClients;
  if (agentFilter !== 'all') list = list.filter(c => {
    const s = classify(c);
    if (agentFilter === 'available') return s === 'available' || s === 'mine';
    if (agentFilter === 'insession') return s === 'mine' || s === 'busy';
    return s === agentFilter;
  });
  if (agentSearch) list = list.filter(c => c.id.toLowerCase().includes(agentSearch));

  grid.innerHTML = '';
  grid.style.display  = list.length ? '' : 'none';
  empty.style.display = list.length ? 'none' : 'block';
  if (!list.length) {
    const none = lastClients.length === 0;
    $('agents-empty-title').textContent = none ? 'No agents yet' : 'No agents match';
    $('agents-empty-text').textContent  = none
      ? 'Add an agent to get an installation code, then install the app on that computer.'
      : 'Try a different filter, or clear the search.';
    $('agents-empty-add').style.display = none ? '' : 'none';
  }

  list.forEach(c => {
    const s = classify(c);
    const connectable = (s === 'available' || s === 'mine');
    // Pending slots can be cleared by any support user; deleting a REAL agent
    // is admin-only (the server enforces this too — mirror it so we don't show
    // a button that silently does nothing).
    const canRemove   = !c.isBusy && targetClientId !== c.id
                        && (s === 'toinstall' || ((s === 'offline' || s === 'unavailable') && agentRole === 'admin'));

    const card = document.createElement('div');
    card.className = 'agent-card is-' + s + (connectable ? ' connectable' : '') + (openMenuFor === c.id ? ' menu-open' : '');
    card.title = STATUS_HINT[s];

    // ── header: platform, name, menu button ──
    const head = document.createElement('div');
    head.className = 'ac-head';
    head.innerHTML =
      `<span class="ac-ico">${c.pending ? ICONS.pending : platformIcon(c)}</span>` +
      `<div class="ac-meta"><div class="ac-name">${esc(c.id)}</div><div class="ac-sub">${esc(agentSubtitle(c))}</div></div>`;
    const menuBtn = document.createElement('button');
    menuBtn.className = 'icon-btn sm card-menu-btn';
    menuBtn.innerHTML = ICONS.more;
    menuBtn.title = 'More actions';
    menuBtn.setAttribute('aria-label', 'More actions for ' + c.id);
    sizeIcon(menuBtn, '16');
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openMenuFor = (openMenuFor === c.id) ? null : c.id;
      renderAgents();
    });
    head.appendChild(menuBtn);
    card.appendChild(head);

    // ── body: installation code (pending) / customer (owner view) ──
    if (s === 'toinstall' && c.installCode) {
      const codeEl = document.createElement('div');
      codeEl.className = 'ac-code';
      codeEl.title = 'Installation code — the app asks for this on first launch';
      codeEl.innerHTML = `<span>${esc(c.installCode)}</span>`;
      const copyBtn = document.createElement('button');
      copyBtn.className = 'icon-btn sm';
      copyBtn.title = 'Copy code';
      copyBtn.setAttribute('aria-label', 'Copy installation code');
      copyBtn.innerHTML = ICONS.copy;
      sizeIcon(copyBtn, '15');
      copyBtn.addEventListener('click', (e) => { e.stopPropagation(); copyText(c.installCode, 'Installation code copied'); });
      codeEl.appendChild(copyBtn);
      card.appendChild(codeEl);
    }
    if (agentRole === 'admin') {
      const own = document.createElement('div');
      own.className = 'ac-owner';
      own.innerHTML = `Customer <b>${esc(customerLabel(c))}</b>`;
      card.appendChild(own);
    }

    // ── footer: status + primary action ──
    const foot = document.createElement('div');
    foot.className = 'ac-foot';
    const statusText = s === 'busy' ? 'In session — ' + (c.agentName || 'someone else') : STATUS_TEXT[s];
    foot.innerHTML = `<span class="status-pill st-${s}"><i></i><span>${esc(statusText)}</span></span>`;
    if (connectable) {
      const go = document.createElement('button');
      go.className = 'btn btn-primary btn-sm';
      go.textContent = s === 'mine' ? 'Open session' : 'Connect';
      go.addEventListener('click', (e) => { e.stopPropagation(); openOrConnect(c); });
      foot.appendChild(go);
    } else if (STATUS_NOTE[s]) {
      const note = document.createElement('span');
      note.className = 'ac-hint';
      note.textContent = STATUS_NOTE[s];
      foot.appendChild(note);
    }
    card.appendChild(foot);

    // ── ⋮ menu ──
    const menu = document.createElement('div');
    menu.className = 'card-menu' + (openMenuFor === c.id ? ' open' : '');
    // Clicks on the menu's padding, gaps or divider must not bubble to the card
    // (which would start a session). The items handle their own actions.
    menu.addEventListener('click', (e) => e.stopPropagation());
    const addItem = (icon, label, opts) => {
      const b = document.createElement('button');
      b.innerHTML = icon + '<span></span>';
      b.lastElementChild.textContent = label;
      if (opts.danger) b.className = 'danger';
      if (opts.disabled) b.disabled = true;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        openMenuFor = null;
        renderAgents();          // close the menu first, then act
        opts.onClick();
      });
      menu.appendChild(b);
    };

    addItem(ICONS.connect, s === 'mine' ? 'Open session' : 'Connect', {
      disabled: !connectable,
      onClick: () => openOrConnect(c)
    });

    // Enable / disable support access from the dashboard — the same flag the
    // client's in-app toggle sets. Only meaningful for installed agents.
    if (s !== 'toinstall') {
      addItem(ICONS.power, c.available ? 'Turn support access off' : 'Turn support access on', {
        onClick: async () => {
          const turningOff = c.available;
          if (turningOff && c.isBusy) {
            const ok = await uiConfirm('Turn off support access?',
              'This ends the current session on ' + c.id + '. The agent stays off until it is turned on again.',
              { confirmText: 'Turn off', tone: 'danger' });
            if (!ok) return;
          }
          socket.emit('set_agent_availability', { clientId: c.id, available: !c.available });
          log((turningOff ? 'Turning support access off for ' : 'Turning support access on for ') + c.id + '…');
        }
      });
    }

    // Reassigning a machine to another customer is a product-owner action.
    if (agentRole === 'admin' && s !== 'toinstall') {
      addItem(ICONS.swap, 'Reassign to customer…', { onClick: () => openTransferModal(c) });
    }

    const sep = document.createElement('div');
    sep.className = 'sep';
    menu.appendChild(sep);

    addItem(ICONS.trash, s === 'toinstall' ? 'Delete this code' : 'Remove agent', {
      danger: true,
      disabled: !canRemove,
      onClick: async () => {
        const ok = await uiConfirm(s === 'toinstall' ? 'Delete this installation code?' : 'Remove ' + c.id + '?',
          s === 'toinstall'
            ? 'The code for ' + c.id + ' stops working. You can create a new agent at any time.'
            : 'It disappears from the console and the computer must be set up again with a new installation code.',
          { confirmText: s === 'toinstall' ? 'Delete code' : 'Remove agent', tone: 'danger' });
        if (!ok) return;
        socket.emit('remove_client', c.id);
        log('Removed ' + c.id);
      }
    });
    card.appendChild(menu);

    if (connectable) card.addEventListener('click', () => openOrConnect(c));
    grid.appendChild(card);
  });
}

/* ═══════════════ OVERVIEW ═══════════════ */
function renderOverview(counts) {
  if (!$('kpi-online')) return;
  $('kpi-online').textContent      = counts.online;
  $('kpi-online-foot').textContent = 'of ' + counts.all + (counts.all === 1 ? ' agent' : ' agents');
  $('kpi-available').textContent   = counts.available;
  $('kpi-session').textContent     = counts.insession;
  $('kpi-install').textContent     = counts.toinstall;

  const ready = lastClients
    .filter(c => { const s = classify(c); return s === 'mine' || s === 'available'; })
    .sort((a, b) => (classify(b) === 'mine') - (classify(a) === 'mine'));
  $('home-ready-count').textContent = ready.length
    ? ready.length + (ready.length === 1 ? ' agent' : ' agents') + ' you can reach right now'
    : 'Agents you can reach right now';

  const box = $('home-ready');
  box.innerHTML = '';
  if (!ready.length) {
    const none = counts.all === 0;
    const wrap = document.createElement('div');
    wrap.className = 'empty-state';
    wrap.innerHTML =
      `<div class="empty-icon">${ICONS.laptop}</div>` +
      `<h4>${none ? 'No agents yet' : 'Nothing to connect to right now'}</h4>` +
      `<p>${none ? 'Add your first agent to get an installation code for a computer.'
                 : 'Agents appear here the moment they come online with support access on.'}</p>`;
    sizeIcon(wrap, '26');
    if (none) {
      const b = document.createElement('button');
      b.className = 'btn btn-primary';
      b.textContent = 'Add your first agent';
      b.addEventListener('click', openCreateAgentModal);
      wrap.appendChild(b);
    }
    box.appendChild(wrap);
    return;
  }
  ready.slice(0, 6).forEach(c => {
    const mine = classify(c) === 'mine';
    const row = document.createElement('div');
    row.className = 'list-row';
    const sub = agentSubtitle(c) + (agentRole === 'admin' ? ' · ' + customerLabel(c) : '');
    row.innerHTML =
      `<span class="os-ico dot ${mine ? 'live' : 'ok'}">${platformIcon(c)}</span>` +
      `<span class="row-main"><b>${esc(c.id)}</b><small>${esc(mine ? 'In session with you' : sub)}</small></span>`;
    const go = document.createElement('button');
    go.className = mine ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm';
    go.textContent = mine ? 'Open session' : 'Connect';
    go.addEventListener('click', () => openOrConnect(c));
    row.appendChild(go);
    box.appendChild(row);
  });
  if (ready.length > 6) {
    const more = document.createElement('div');
    more.className = 'list-row';
    more.innerHTML = `<span class="row-main"><small>+ ${ready.length - 6} more available</small></span>`;
    const all = document.createElement('button');
    all.className = 'link-btn';
    all.textContent = 'View all';
    all.addEventListener('click', () => { agentFilter = 'available'; syncFilterButtons(); openTab('agents'); renderAgents(); });
    more.appendChild(all);
    box.appendChild(more);
  }
}

function tabTitleFor(id) {
  return id.length > 22 ? id.slice(0, 21) + '…' : id;
}

/* ═══════════════ SESSION ═══════════════ */
socket.on('session_blocked', (msg) => {
  log('Blocked: ' + msg);
  toast('Cannot connect: ' + msg, 'error');
  // The request was refused, so there is no session — don't leave the user on
  // a "Connecting…" screen that will never resolve.
  if (!peerConnection) {
    if (targetClientId) socket.emit('end_session', targetClientId);   // release any server-side session we abandon
    targetClientId = null;
    openTabs = openTabs.filter(t => t !== 'session');
    showPlaceholderUI();
    if (currentView === 'session') showView(openTabs.includes('agents') ? 'agents' : 'home');
    else renderTabs();
  }
});

function connectToClient(clientId) {
  if (peerConnection) cleanupPeer();
  // One live session per console: leaving for another machine ends the first.
  if (targetClientId && targetClientId !== clientId) socket.emit('end_session', targetClientId);
  targetClientId = clientId;
  refreshIce();   // fetch fresh TURN credentials now, off the offer path
  document.getElementById('session-client-name').textContent = clientId;
  setPlaceholder('Connecting to ' + clientId + '…', 'Waiting for the agent\'s screen');
  openTab('session', tabTitleFor(clientId));
  log('Requesting connection to ' + clientId);
  socket.emit('request_connection', clientId);
}

function cleanupPeer() {
  releaseAllRemoteKeys();
  releaseAllRemoteButtons();
  stopClipSync();
  lastClientClip = null;
  lastSentClip = null;
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  if (dataChannel)    { dataChannel.close();    dataChannel = null;    }
  currentOfferSender = null;
  pendingCandidates = [];
  video.srcObject = null;
  updateCursorMode();
}

function endCurrentSession() {
  cleanupPeer();
  if (targetClientId) {
    socket.emit('end_session', targetClientId);
    targetClientId = null;
  }
  showPlaceholderUI();
  log('Session ended.');
}

document.getElementById('disconnect-btn').addEventListener('click', () => {
  endCurrentSession();
  openTabs = openTabs.filter(t => t !== 'session');
  showView(openTabs.includes('agents') ? 'agents' : 'home');
});

document.getElementById('reconnect-btn').addEventListener('click', () => {
  if (!targetClientId) return;
  log('Forcing video reconnect...');
  cleanupPeer();
  refreshIce();
  socket.emit('request_connection', targetClientId);
});

socket.on('session_ended', (d) => {
  // A late notice about a machine this console has already moved on from.
  if (d && d.clientId && targetClientId && d.clientId !== targetClientId) return;
  const why = {
    client_ended: 'The person at the computer ended the session.',
    disabled_by_support: 'Support access was turned off for this computer.',
    agent_transferred: 'This computer was reassigned to another customer.',
    client_timeout: 'The computer did not come back online.',
    signed_in_elsewhere: 'You signed in on another window or device.'
  }[d && d.reason];
  if (why && targetClientId) toast('Session ended. ' + why, 'info');
  log('Session ended' + (d && d.reason ? ' (' + d.reason + ')' : ' (remote side)'));
  cleanupPeer();
  targetClientId = null;
  showPlaceholderUI();
  openTabs = openTabs.filter(t => t !== 'session');
  if (currentView === 'session') showView(openTabs.includes('agents') ? 'agents' : 'home');
  else renderTabs();
});

socket.on('session_restored', (data) => {
  targetClientId = data.clientId;
  document.getElementById('session-client-name').textContent = data.clientId;
  setPlaceholder('Waiting for ' + data.clientId + ' to reconnect…', 'Session was preserved');
  showVideoUI();
  openTab('session', tabTitleFor(data.clientId));
  log('Session restored with ' + data.clientId + ' — waiting for client...');
  cleanupPeer();
});

socket.on('client_reconnecting', (data) => {
  log('Client ' + data.clientId + ' went offline — session preserved, waiting...');
  setPlaceholder('Reconnecting to ' + data.clientId + '…', 'Client went offline — session is preserved');
  document.getElementById('placeholder').style.display = 'flex';
});

socket.on('client_reconnected', (data) => {
  log('Client ' + data.clientId + ' is back online — video reconnecting...');
  cleanupPeer();
  // Client sends a fresh offer next
});

/* ═══════════════ WEBRTC ═══════════════ */
socket.on('offer', async (data) => {
  // Only accept an offer for the machine this console actually connected to.
  // An offer that arrives when we are not connecting to anyone is ignored, so a
  // machine cannot push its screen to a console that did not ask for it.
  if (!targetClientId) { log('Ignoring unsolicited offer (no active connection)'); return; }
  if (!data || !data.sdp) return;
  log('WebRTC offer received from client');

  // A fresh offer (first connect or a re-share) replaces any existing peer —
  // close the old one first so we never leak a connection or route input to it.
  if (peerConnection) { try { peerConnection.close(); } catch (_) {} }
  if (dataChannel)    { try { dataChannel.close(); } catch (_) {} dataChannel = null; }
  pendingCandidates = [];
  currentOfferSender = data.sender;

  const connStart = Date.now();
  // Built synchronously with the cached ICE config (refreshed at connect time,
  // not on this path) so candidates that arrive immediately are not dropped.
  const pc = new RTCPeerConnection(Object.assign({ bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' }, iceConfig));
  peerConnection = pc;
  let loggedPath = false;   // log the negotiated ICE path (host/srflx/relay + RTT) once

  pc.ontrack = (event) => {
    log(`Video stream received (${Date.now() - connStart}ms)`);
    // Remote desktop wants the freshest frame, not smooth playback: drain the
    // receive jitter buffer instead of letting it hold ~100-200ms of "safety".
    try {
      if ('jitterBufferTarget' in event.receiver) event.receiver.jitterBufferTarget = 0;
      else if ('playoutDelayHint' in event.receiver) event.receiver.playoutDelayHint = 0;
    } catch (_) {}
    if (video.srcObject !== event.streams[0]) {
      video.srcObject = event.streams[0];
      video.play().catch(() => {});   // recover if autoplay is ever blocked (frozen last frame reads as infinite lag)
      showVideoUI();
      document.getElementById('placeholder').style.display = 'none';
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) socket.emit('ice-candidate', { target: data.sender, candidate: event.candidate });
  };

  pc.oniceconnectionstatechange = async () => {
    if (peerConnection !== pc) return;
    log('ICE state: ' + pc.iceConnectionState);
    if (loggedPath) return;
    if (pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed') return;
    loggedPath = true;
    // Surface the real network path so a laggy session is diagnosable in the
    // field: 'relay' on either side = media is detouring through the TURN.
    try {
      const s = await pc.getStats();
      let p = null;
      s.forEach(r => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') p = r; });
      if (!p) { loggedPath = false; return; }
      const L = s.get(p.localCandidateId), R = s.get(p.remoteCandidateId);
      const types = ((L && L.candidateType) || '?') + '/' + ((R && R.candidateType) || '?');
      const relayed = (L && L.candidateType === 'relay') || (R && R.candidateType === 'relay');
      log('path ' + types + ' rtt=' + Math.round((p.currentRoundTripTime || 0) * 1000) + 'ms' + (relayed ? ' - RELAYED (slow detour; fix: TURN nearer the users)' : ' - direct'));
    } catch (_) { loggedPath = false; }
  };
  pc.onconnectionstatechange = () => { if (peerConnection === pc) log('Connection state: ' + pc.connectionState); };

  pc.ondatachannel = (event) => {
    dataChannel = event.channel;
    dataChannel.onopen = () => {
      log('Input channel open — remote control active');
      startClipSync();
      updateCursorMode();
      sendQuality();   // (re)apply the chosen quality on every fresh channel
    };
    dataChannel.onclose = () => { heldButtons.clear(); updateCursorMode(); };
    dataChannel.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'clipboard_content') handleClientClip(String(msg.text || ''));
      } catch (_) {}
    };
  };

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    if (peerConnection !== pc) return;   // superseded while awaiting
    for (const c of pendingCandidates) { try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {} }
    pendingCandidates = [];
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { target: data.sender, sdp: answer });
    log('WebRTC answer sent');
  } catch (e) { log('Offer handling error: ' + e.message); }
});

socket.on('answer', async (data) => {
  if (peerConnection && (!currentOfferSender || data.sender === currentOfferSender)) {
    try { await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp)); }
    catch (e) { log('Answer error: ' + e.message); }
  }
});

socket.on('ice-candidate', async (data) => {
  if (currentOfferSender && data.sender && data.sender !== currentOfferSender) return;   // not our peer
  const c = data.candidate;
  if (!c) return;
  // Queue until the peer exists and its remote description is set, else the
  // candidate is lost and the direct (non-relayed) path may never form.
  if (!peerConnection || !peerConnection.remoteDescription) { pendingCandidates.push(c); return; }
  try { await peerConnection.addIceCandidate(new RTCIceCandidate(c)); } catch (e) {}
});

/* ═══════════════ SESSION UI HELPERS ═══════════════ */
function setPlaceholder(main, sub, idle) {
  $('placeholder-text').textContent = main;
  $('placeholder-sub').textContent  = sub || '';
  $('placeholder').classList.toggle('idle', !!idle);   // idle = nothing in progress, no spinner
  $('placeholder').style.display = 'flex';
}

function showVideoUI() {
  // Controls live in the always-visible session sidebar now — nothing to toggle.
}

function showPlaceholderUI() {
  setPlaceholder('No active session', 'Pick an agent from the Agents page', true);
}

function showToast(msg, isError) {
  const t = document.getElementById('clip-toast');
  t.textContent = msg;
  t.style.background = isError ? 'rgba(217,83,79,0.92)' : 'rgba(47,158,68,0.92)';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

/* ═══════════════ FULLSCREEN (+ system-key capture) ═══════════════ */
document.getElementById('fullscreen-btn').addEventListener('click', () => {
  // Fullscreen the WHOLE session view (sidebar + video), not just the video —
  // otherwise End Session / Reconnect / the toggles vanish in fullscreen and,
  // with keyboard-lock on, Esc gets forwarded to the remote instead of exiting.
  const target = document.getElementById('view-session');
  if (!document.fullscreenElement) {
    target.requestFullscreen().catch(() => video.requestFullscreen());
  } else {
    document.exitFullscreen();
  }
});

// In fullscreen, lock the keyboard so even Ctrl+W / Alt+Tab-class shortcuts
// reach the remote PC instead of the browser (Chrome/Edge Keyboard Lock API).
document.addEventListener('fullscreenchange', () => {
  if (navigator.keyboard && navigator.keyboard.lock) {
    if (document.fullscreenElement) {
      navigator.keyboard.lock().then(() => log('Keyboard locked — system shortcuts now go to remote'))
                               .catch(() => {});
    } else {
      navigator.keyboard.unlock();
    }
  }
});

/* ═══════════════ CONTROL TOGGLES + CLIPBOARD ═══════════════ */
document.getElementById('ctrl-mouse').addEventListener('click', () => {
  mouseEnabled = !mouseEnabled;
  const btn = document.getElementById('ctrl-mouse');
  document.getElementById('ctrl-mouse-label').textContent = mouseEnabled ? 'Mouse: ON' : 'Mouse: OFF';
  btn.className = 'sside-btn sside-toggle' + (mouseEnabled ? ' ctrl-on' : ' ctrl-off');
  if (!mouseEnabled) releaseAllRemoteButtons();
  updateCursorMode();
  log('Mouse control: ' + (mouseEnabled ? 'ON' : 'OFF'));
});

document.getElementById('ctrl-keyboard').addEventListener('click', () => {
  keyboardEnabled = !keyboardEnabled;
  const btn = document.getElementById('ctrl-keyboard');
  document.getElementById('ctrl-keyboard-label').textContent = keyboardEnabled ? 'Keyboard: AUTO' : 'Keyboard: OFF';
  btn.className = 'sside-btn sside-toggle' + (keyboardEnabled ? ' ctrl-on' : ' ctrl-off');
  if (!keyboardEnabled) releaseAllRemoteKeys();
  updateKbdPill();
  log('Keyboard control: ' + (keyboardEnabled ? 'AUTO (follows mouse)' : 'OFF'));
});

/* ── Screen quality (Low / Medium / High) ──
   The client owns the encoder; we just tell it which preset to apply. The
   choice is remembered per browser and re-sent whenever a channel opens, so
   a reconnect or a new session keeps the same setting. Older clients ignore
   the message and stream at their default (High). */
const qualitySelect = document.getElementById('ctrl-quality');
try {
  // One-time: the old default was High (60fps/10Mbps full-res), which overloads
  // a software encoder and reads as lag. Move anyone still parked on a saved
  // 'high' down to Medium once, so the fix actually reaches existing viewers. A
  // deliberate re-pick of High afterwards sticks (the migration runs only once).
  if (localStorage.getItem('ts_quality') === 'high' && !localStorage.getItem('ts_q_mig_v2')) {
    localStorage.setItem('ts_quality', 'medium');
  }
  localStorage.setItem('ts_q_mig_v2', '1');
  const saved = localStorage.getItem('ts_quality');
  if (saved && [...qualitySelect.options].some(o => o.value === saved)) qualitySelect.value = saved;
} catch (_) {}

function sendQuality() {
  if (!dc()) return;
  dataChannel.send(JSON.stringify({ type: 'quality', level: qualitySelect.value }));
}

qualitySelect.addEventListener('change', () => {
  try { localStorage.setItem('ts_quality', qualitySelect.value); } catch (_) {}
  sendQuality();
  log('Screen quality: ' + qualitySelect.options[qualitySelect.selectedIndex].text);
});

document.getElementById('ctrl-send-clip').addEventListener('click', async () => {
  if (!dc()) return;
  try {
    const text = await navigator.clipboard.readText();
    if (!text) { showToast('Your clipboard is empty', true); return; }
    lastSentClip = text;   // so the auto-sync doesn't echo it straight back
    dataChannel.send(JSON.stringify({ type: 'clipboard_write', text }));
    showToast('Clipboard sent to client ✓');
    log('Clipboard sent to client (' + text.length + ' chars)');
  } catch (e) {
    showToast('Clipboard access denied — allow in browser settings', true);
  }
});

/* ── Auto clipboard sync (client → agent) ──
   The client app answers clipboard_request with clipboard_content, so we poll
   once a second during a session; whenever the CLIENT copies something new it
   lands in the agent's clipboard automatically. The first reply only sets the
   baseline — whatever was already in the client clipboard before the session
   is not pulled. */
let clipPollTimer  = null;
let lastClientClip = null;   // null = baseline not captured yet
let lastSentClip   = null;   // last text we pushed via "Send My Clipboard"
let pendingClip    = null;   // arrived while the tab was unfocused

function startClipSync() {
  stopClipSync();
  lastClientClip = null;
  // The reply shares the single ordered input channel, so polling mid-drag
  // head-of-line-blocks moves AND keys. Poll less often, and never while the
  // pointer is actively moving (clicks/keys use sendNow and are never gated).
  clipPollTimer = setInterval(() => {
    if (!dc()) return;
    if (Date.now() - lastMoveAt < 250) return;
    dataChannel.send(JSON.stringify({ type: 'clipboard_request' }));
  }, 2500);
}

function stopClipSync() {
  if (clipPollTimer) { clearInterval(clipPollTimer); clipPollTimer = null; }
}

function handleClientClip(text) {
  if (lastClientClip === null) { lastClientClip = text; return; }  // baseline
  if (text === lastClientClip) return;                             // no change
  lastClientClip = text;
  if (!text || text === lastSentClip) return;  // empty, or our own push coming back
  deliverClipToAgent(text);
}

function deliverClipToAgent(text) {
  navigator.clipboard.writeText(text).then(() => {
    pendingClip = null;
    showToast('Client copied — it\'s in your clipboard ✓');
    log('Auto clipboard: received ' + text.length + ' chars from client');
  }).catch(() => {
    // Browsers refuse clipboard writes while the tab is unfocused — hold the
    // latest text and deliver it the moment the agent comes back.
    pendingClip = text;
  });
}

window.addEventListener('focus', () => {
  if (pendingClip) deliverClipToAgent(pendingClip);
});

/* ═══════════════ INSTALL / ACCOUNT / ACTIVITY ═══════════════ */
const downloadPageUrl = () => window.location.origin + '/download.html';
$('btn-copy').addEventListener('click', () => copyText(downloadPageUrl(), 'Download link copied'));
$('qa-copy').addEventListener('click', () => copyText(downloadPageUrl(), 'Download link copied'));

$('force-reset-btn').addEventListener('click', async () => {
  const ok = await uiConfirm('Reset all sessions?',
    'Every live session on the server is disconnected immediately — for all customers. Use this only when sessions are stuck.',
    { confirmText: 'Reset all sessions', tone: 'danger' });
  if (ok) socket.emit('force_reset_all');
});

socket.on('server_reset', () => {
  toast('All sessions were reset by the product owner. Reloading…', 'info');
  setTimeout(() => window.location.reload(), 1600);
});

document.getElementById('log-clear').addEventListener('click', () => {
  document.getElementById('debug-logs').innerHTML = '<div>&gt; Log cleared.</div>';
});

/* ═══════════════ REMOTE INPUT — DWService-style routing ═══════════════
   Rule: while your mouse pointer is INSIDE the remote screen, your mouse
   and keyboard drive the remote PC (browser shortcuts are suppressed).
   The moment the pointer leaves the screen, everything is local again. */

function dc() { return dataChannel && dataChannel.readyState === 'open'; }

let pointerOverScreen = false;
const pressedRemoteKeys = new Set();   // codes currently held down on the remote

function keyRoutingActive() {
  // A confirm dialog on top of the session must get the keys, not the remote PC.
  return keyboardEnabled && pointerOverScreen && currentView === 'session' && dc() && !dialogResolve;
}

function updateKbdPill() {
  document.getElementById('kbd-pill').classList.toggle('on', keyRoutingActive());
}

video.addEventListener('mouseenter', () => {
  pointerOverScreen = true;
  updateKbdPill();
});

video.addEventListener('mouseleave', () => {
  pointerOverScreen = false;
  releaseAllRemoteKeys();   // never leave Ctrl/Shift/etc. stuck on the remote
  updateKbdPill();
});

// If the browser window loses focus (Alt+Tab etc.), release held remote keys
// and buttons — a drag interrupted by Alt+Tab must not stay held remotely.
window.addEventListener('blur', () => { releaseAllRemoteKeys(); releaseAllRemoteButtons(); });

function releaseAllRemoteKeys() {
  if (pressedRemoteKeys.size && dc()) {
    for (const code of pressedRemoteKeys) {
      dataChannel.send(JSON.stringify({ type: 'keyup', key: '', code }));
    }
  }
  pressedRemoteKeys.clear();
  updateKbdPill();
}

window.addEventListener('keydown', (e) => {
  if (!keyRoutingActive()) return;          // pointer outside → fully local keyboard
  e.preventDefault();                        // pointer inside → nothing reaches the browser
  e.stopPropagation();
  pressedRemoteKeys.add(e.code);
  dataChannel.send(JSON.stringify({ type: 'keydown', key: e.key, code: e.code }));
}, true);

window.addEventListener('keyup', (e) => {
  // Always complete a key we sent down — even if the pointer slipped out
  // between keydown and keyup — so the remote never has a stuck key.
  if (pressedRemoteKeys.has(e.code)) {
    e.preventDefault();
    e.stopPropagation();
    pressedRemoteKeys.delete(e.code);
    if (dc()) dataChannel.send(JSON.stringify({ type: 'keyup', key: e.key, code: e.code }));
    updateKbdPill();
    return;
  }
  if (!keyRoutingActive()) return;
  e.preventDefault();
  e.stopPropagation();
  dataChannel.send(JSON.stringify({ type: 'keyup', key: e.key, code: e.code }));
}, true);

/* ── Mouse → remote (only over the screen, like DWService) ── */

// The real picture rect inside <video> (object-fit: contain letterboxing).
function videoContentRect() {
  const r = video.getBoundingClientRect();
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return { left: r.left, top: r.top, width: r.width, height: r.height };
  const elemAspect = r.width / r.height;
  const vidAspect  = vw / vh;
  if (vidAspect > elemAspect) {
    const h = r.width / vidAspect;
    return { left: r.left, top: r.top + (r.height - h) / 2, width: r.width, height: h };
  }
  const w = r.height * vidAspect;
  return { left: r.left + (r.width - w) / 2, top: r.top, width: w, height: r.height };
}

// Pointer position → normalised picture coordinates (0..1). CSS-pixel rect and
// clientX/Y are in the same space, so browser zoom, fullscreen and window
// resizes cancel out; the client maps 0..1 onto its own physical display.
// Clamped so a drag that leaves the picture keeps tracking along the edge.
function normPoint(e) {
  const c = videoContentRect();
  return {
    x: Math.max(0, Math.min(1, (e.clientX - c.left) / c.width)),
    y: Math.max(0, Math.min(1, (e.clientY - c.top)  / c.height))
  };
}

// Always transmit the LATEST mouse position (~60fps trailing throttle).
let pendingMove = null, moveTimer = null;
let lastMoveAt = 0;   // last pointermove time — gates the clipboard poll off active drags
function flushMove() {
  // Shed stale moves (never clicks/keys) when the channel is backed up, so a
  // stalled uplink can't pile up hundreds of ms of outdated cursor positions.
  // On a healthy link bufferedAmount is ~0, so this behaves exactly as before.
  if (pendingMove && dc() && dataChannel.bufferedAmount < 65536) {
    dataChannel.send(JSON.stringify(pendingMove));
    pendingMove = null;
    moveTimer = setTimeout(flushMove, 16);
  } else if (pendingMove && dc()) {
    moveTimer = setTimeout(flushMove, 16);   // backed up: keep the newest, retry
  } else {
    moveTimer = null;
  }
}

// Button events must never overtake the move that positioned them: send the
// pending move first, then the click. (The client applies them in order and
// the click also carries its own position — belt and braces.)
function sendNow(msg) {
  if (!dc()) return;
  if (pendingMove) { dataChannel.send(JSON.stringify(pendingMove)); pendingMove = null; }
  dataChannel.send(JSON.stringify(msg));
}

const heldButtons = new Set();   // buttons currently pressed on the remote
// Only left/right/middle are forwarded. Back/Forward (3/4) are ignored so they
// never arrive as a stray middle-click that closes a tab on the customer's PC.
const BUTTON_BITS = [['left', 1], ['right', 2], ['middle', 4]];

// Pointer Events only fire pointerdown for the FIRST button pressed and
// pointerup for the LAST released; a chorded press/release arrives as a
// pointermove. So, on every pointer event, bring the remote into line with the
// current e.buttons bitmask — sending the mousedown / mouseup each change needs.
// This also guarantees a button can never stay held because its own event was
// coalesced away.
function reconcileButtons(e, pt) {
  if (!mouseEnabled || !dc()) return;
  for (const [name, bit] of BUTTON_BITS) {
    const down = (e.buttons & bit) !== 0;
    if (down && !heldButtons.has(name)) { heldButtons.add(name); sendNow(Object.assign({ type: 'mousedown', button: name }, pt)); }
    else if (!down && heldButtons.has(name)) { heldButtons.delete(name); sendNow(Object.assign({ type: 'mouseup', button: name }, pt)); }
  }
}

// A press we sent must always be completed — pointer cancelled, window lost
// focus mid-drag, mouse control switched off, session torn down.
function releaseAllRemoteButtons() {
  if (heldButtons.size && dc()) {
    for (const button of heldButtons) sendNow({ type: 'mouseup', button });
  }
  heldButtons.clear();
}

// One cursor, not two. Chromium always embeds the remote machine's cursor in
// the captured stream (it ignores the `cursor` constraint), so the agent's
// own arrow on top of it read as a duplicate that the embedded one trailed by
// the stream latency. While control is live the picture hides the local
// pointer and the embedded cursor — the real one, at the real click point,
// with the real shape (I-beam, resize, hand) — is what the agent steers.
function updateCursorMode() {
  video.classList.toggle('remote-cursor', mouseEnabled && dc());
}

video.addEventListener('pointermove', (e) => {
  if (!mouseEnabled || !dc()) return;
  lastMoveAt = Date.now();
  const pt = normPoint(e);
  pendingMove = Object.assign({ type: 'mousemove' }, pt);
  if (!moveTimer) flushMove();
  reconcileButtons(e, pt);   // a button pressed/released mid-drag has no event of its own
});

video.addEventListener('pointerdown', (e) => {
  if (!mouseEnabled || !dc()) return;
  if (e.button > 2) { e.preventDefault(); return; }   // thumb buttons: don't forward, don't let the browser navigate
  // Capture the pointer so a drag that leaves the picture keeps delivering
  // moves and — crucially — its pointerup. Without it the remote button stayed
  // held whenever a drag ended outside the video.
  try { video.setPointerCapture(e.pointerId); } catch (_) {}
  // pointerdown IS the press of e.button — register it directly (e.buttons can
  // read 0 for synthesized events). Chorded extra buttons come via pointermove.
  const pt = normPoint(e);
  const name = e.button === 0 ? 'left' : e.button === 2 ? 'right' : 'middle';
  if (!heldButtons.has(name)) { heldButtons.add(name); sendNow(Object.assign({ type: 'mousedown', button: name }, pt)); }
});

video.addEventListener('pointerup', (e) => {
  if (e.button > 2) { e.preventDefault(); return; }
  reconcileButtons(e, normPoint(e));
});

video.addEventListener('pointercancel', releaseAllRemoteButtons);
video.addEventListener('contextmenu', e => e.preventDefault());

// Safety net: a release (or lost focus) that never reaches the picture must
// still free any held remote button — it must never stick on the customer's PC.
window.addEventListener('pointerup', (e) => {
  if (heldButtons.size && e.target !== video) releaseAllRemoteButtons();
}, true);
window.addEventListener('blur', () => { if (heldButtons.size) releaseAllRemoteButtons(); });

video.addEventListener('wheel', (e) => {
  if (!mouseEnabled || !dc()) return;
  e.preventDefault();
  // Normalise to pixels: deltaMode 1 = lines, 2 = pages (Firefox / some
  // mice). The client accumulates and turns 100px into one wheel notch.
  const unit = e.deltaMode === 1 ? 100 / 3 : e.deltaMode === 2 ? 300 : 1;
  sendNow({ type: 'scroll', deltaX: e.deltaX * unit, deltaY: e.deltaY * unit });
}, { passive: false });
