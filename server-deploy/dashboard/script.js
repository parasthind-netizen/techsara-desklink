const socket = io();
const video  = document.getElementById('remote-video');

let peerConnection = null;
let dataChannel    = null;
let targetClientId = null;
let agentName      = '';
let agentRole      = 'support';

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

function log(msg) {
  const el = document.getElementById('debug-logs');
  if (!el) return;
  const div = document.createElement('div');
  div.textContent = `> ${new Date().toLocaleTimeString()}: ${msg}`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

/* ═══════════════ TAB SYSTEM ═══════════════ */
const TAB_TITLES = {
  agents:   'Agents',
  session:  'Session',
  activity: 'Analyze events',
  install:  'Install Agent',
  account:  'My Account',
  admin:    'Admin Panel'
};
let openTabs    = [];
let currentView = 'home';

function showView(id) {
  currentView = id;
  ['home', 'agents', 'session', 'activity', 'install', 'account', 'admin'].forEach(v => {
    const el = document.getElementById('view-' + v);
    if (el) el.style.display = (v === id) ? (v === 'agents' || v === 'session' ? 'flex' : 'block') : 'none';
  });
  if (id === 'admin') { socket.emit('admin_list_users'); socket.emit('admin_feed_info'); }
  renderTabs();
}

function openTab(id, title) {
  if (title) TAB_TITLES[id] = title;
  if (!openTabs.includes(id)) openTabs.push(id);
  showView(id);
}

function closeTab(id) {
  if (id === 'session' && targetClientId) {
    if (!confirm('End the session with ' + targetClientId + '?')) return;
    endCurrentSession();
  }
  openTabs = openTabs.filter(t => t !== id);
  if (currentView === id) showView(openTabs.length ? openTabs[openTabs.length - 1] : 'home');
  else renderTabs();
}

function renderTabs() {
  const strip = document.getElementById('tab-strip');
  strip.innerHTML = '';
  openTabs.forEach(id => {
    const b = document.createElement('button');
    b.className = 'tab' + (currentView === id ? ' active' : '');
    b.textContent = TAB_TITLES[id];
    const x = document.createElement('span');
    x.className = 'tab-close';
    x.textContent = '✕';
    x.addEventListener('click', (e) => { e.stopPropagation(); closeTab(id); });
    b.appendChild(x);
    b.addEventListener('click', () => showView(id));
    strip.appendChild(b);
  });
}

document.getElementById('btn-home').addEventListener('click', () => showView('home'));
document.querySelectorAll('.tile').forEach(t =>
  t.addEventListener('click', () => openTab(t.dataset.open)));
document.getElementById('bell-btn').addEventListener('click', () => {
  agentFilter = 'available';
  syncFilterButtons();
  openTab('agents');
  renderAgents();
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
  // dashboard working instead of leaving it connected-but-unregistered.
  const savedName = sessionStorage.getItem('ts_agent_name');
  const savedPwd  = sessionStorage.getItem('ts_agent_pwd');
  if (savedName && savedPwd) {
    agentName = savedName;
    socket.emit('register', { type: 'support', username: savedName, password: savedPwd });
  }
});

socket.on('disconnect', () => {
  serverIndicator.classList.add('offline');
  const conn = document.getElementById('acct-conn');
  if (conn) conn.textContent = 'Disconnected — reconnecting…';
  log('Disconnected from server');
});

/* ═══════════════ LOGIN / LOGOUT ═══════════════ */
document.getElementById('login-btn').addEventListener('click', doLogin);
document.getElementById('admin-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});

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
  const name = document.getElementById('admin-name').value.trim().toLowerCase();
  const pwd  = document.getElementById('admin-password').value;
  const err  = document.getElementById('login-error');
  if (!name || !pwd) {
    err.textContent = 'Please enter your username and password.';
    err.style.display = 'block';
    return;
  }
  agentName = name;
  sessionStorage.setItem('ts_agent_name', name);
  sessionStorage.setItem('ts_agent_pwd', pwd);
  socket.emit('register', { type: 'support', username: name, password: pwd });
}

socket.on('login_success', (info) => {
  agentRole = (info && info.role) || 'support';
  if (info && info.username) agentName = info.username;
  // A silent re-login after a reconnect must not yank the user back to Home.
  const freshLogin = document.getElementById('login-screen').style.display !== 'none';
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  document.getElementById('acct-name').textContent   = agentName;
  document.getElementById('acct-role').textContent   = agentRole === 'admin' ? 'Administrator' : 'Support agent';
  document.getElementById('acct-server').textContent = window.location.origin;
  document.getElementById('acct-conn').textContent   = 'Connected';
  document.getElementById('copy-url').textContent    = window.location.origin + '/download.html';

  // Show/hide admin-only UI
  const isAdmin = agentRole === 'admin';
  document.querySelectorAll('.admin-only').forEach(el => el.style.display = isAdmin ? '' : 'none');

  refreshIce();
  socket.emit('list_support_users');
  if (freshLogin) showView('home');
  log('Login successful — welcome, ' + agentName + ' (' + agentRole + ')');
});

socket.on('force_logout', (msg) => {
  alert(msg || 'You were logged out.');
  hardLogout();
});

socket.on('login_error', (msg) => {
  sessionStorage.removeItem('ts_agent_name');
  sessionStorage.removeItem('ts_agent_pwd');
  // If this failure came from a silent re-login while the app was open (e.g.
  // the account was removed, or the server restarted and lost our session),
  // the login screen is hidden — writing into it would leave a zombie tab that
  // looks connected but is ignored by the server. Fall back to a full logout.
  if (document.getElementById('app').style.display !== 'none') {
    alert('Your session ended: ' + msg + '\nPlease sign in again.');
    hardLogout();
    return;
  }
  const err = document.getElementById('login-error');
  err.textContent = 'Login failed: ' + msg;
  err.style.display = 'block';
});

document.getElementById('logout-btn').addEventListener('click', doLogout);
document.getElementById('acct-logout').addEventListener('click', doLogout);

function doLogout() {
  if (!confirm('Log out of the console? Any active session will be ended.')) return;
  log('Logging out...');
  socket.emit('agent_logout');
  hardLogout();
}

function hardLogout() {
  cleanupPeer();
  closeCreateAgentModal();
  targetClientId = null;
  sessionStorage.removeItem('ts_agent_name');
  sessionStorage.removeItem('ts_agent_pwd');
  openTabs = [];
  currentView = 'home';
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('admin-password').value = '';
  setPwdVisible(false);
  document.getElementById('login-error').style.display = 'none';
  agentName = '';
  agentRole = 'support';
}

/* ═══════════════ ADMIN PANEL ═══════════════ */
document.getElementById('nu-create').addEventListener('click', () => {
  const username = document.getElementById('nu-username').value.trim();
  const password = document.getElementById('nu-password').value;
  const role     = document.getElementById('nu-role').value;
  if (!username || !password) return adminMsg('Enter a username and password', true);
  socket.emit('admin_create_user', { username, password, role });
});

function adminMsg(text, isError) {
  const m = document.getElementById('admin-msg');
  m.textContent = text;
  m.className = 'admin-msg ' + (isError ? 'err' : 'ok');
  m.style.display = 'block';
  setTimeout(() => { m.style.display = 'none'; }, 4000);
}

socket.on('admin_error', (msg) => adminMsg(msg, true));
socket.on('admin_ok', (msg) => {
  adminMsg(msg, false);
  document.getElementById('nu-username').value = '';
  document.getElementById('nu-password').value = '';
});

socket.on('admin_users', (list) => {
  const tb = document.getElementById('users-tbody');
  tb.innerHTML = '';
  list.forEach(u => {
    const tr = document.createElement('tr');
    const isSelf = u.username === agentName;
    tr.innerHTML =
      `<td>${u.username}${isSelf ? ' <span class="muted small">(you)</span>' : ''}</td>` +
      `<td><span class="role-pill ${u.role}">${u.role === 'admin' ? 'Administrator' : 'Support agent'}</span></td>` +
      `<td class="muted">${u.createdBy || '—'}</td>` +
      `<td style="text-align:right;"></td>`;
    const td = tr.lastElementChild;
    const del = document.createElement('button');
    del.className = 'tbl-del';
    del.textContent = 'Delete';
    del.disabled = isSelf;
    del.addEventListener('click', () => {
      if (confirm('Delete user "' + u.username + '"?')) socket.emit('admin_delete_user', { username: u.username });
    });
    td.appendChild(del);
    tb.appendChild(tr);
  });
  renderAdminAgents();
});

function renderAdminAgents() {
  const tb = document.getElementById('admin-agents-tbody');
  if (!tb) return;
  tb.innerHTML = '';
  lastClients.forEach(c => {
    const tr = document.createElement('tr');
    const dot = c.pending ? '<span class="st-dot off"></span>To install — code ' + (c.installCode || '')
              : c.online ? '<span class="st-dot on"></span>Online' : '<span class="st-dot off"></span>Offline';
    const avail = c.pending ? '' : (c.available ? ' · Available' : ' · Disabled');
    const ver = c.pending ? '—' : (c.version || 'unknown')
              + (c.platform === 'mac' ? ' <span class="muted small">· macOS</span>' : '')
              + (c.updateAvailable ? ' <span class="muted small">(update available)</span>' : '');
    tr.innerHTML = `<td>${c.id}</td><td>${ver}</td><td>${dot}${avail}</td><td style="text-align:right;white-space:nowrap;"></td>`;
    const cell = tr.lastElementChild;

    const upd = document.createElement('button');
    upd.className = 'tbl-btn';
    upd.textContent = 'Update';
    upd.disabled = !c.online || c.isBusy || !c.updateAvailable;
    upd.title = !c.online ? 'Agent must be online'
              : c.isBusy ? 'Cannot update an in-session agent'
              : !c.updateAvailable ? 'Already on the staged version' : 'Push update to this agent (canary)';
    upd.addEventListener('click', () => {
      if (confirm('Push the staged update to canary agent "' + c.id + '"?')) socket.emit('admin_push_update_one', c.id);
    });
    cell.appendChild(upd);

    const del = document.createElement('button');
    del.className = 'tbl-del';
    del.textContent = 'Delete';
    del.disabled = c.isBusy;
    del.title = c.isBusy ? 'Cannot delete an in-session agent' : 'Remove this agent permanently';
    del.addEventListener('click', () => {
      if (confirm('Permanently delete agent "' + c.id + '"? It will disappear until reinstalled/re-enabled.'))
        socket.emit('remove_client', c.id);
    });
    cell.appendChild(del);
    tb.appendChild(tr);
  });
}

/* ── Rollout: push-to-all, reset, canary unlock, version history/rollback ── */
document.getElementById('push-all-btn').addEventListener('click', () => {
  if (confirm('Push the staged update to ALL online, idle agents?')) socket.emit('admin_push_update_all');
});
document.getElementById('reset-rollout-btn').addEventListener('click', () => socket.emit('admin_reset_rollout'));

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
  parts.push('Windows ' + (info.active || 'none'));
  parts.push('macOS ' + (info.activeMac || 'none'));
  document.getElementById('feed-version').textContent =
    parts.join('  ·  ') + (info.rollbackMode ? '  (rollback mode)' : '');
  const btn = document.getElementById('push-all-btn');
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
    tr.innerHTML = `<td>${v}${isActive ? ' <span class="role-pill support">' + servingTag + '</span>' : ''}</td><td></td><td style="text-align:right;"></td>`;
    if (!isActive) {
      const act = document.createElement('button');
      act.className = 'tbl-btn';
      act.textContent = 'Roll back to this';
      act.title = 'Make this version the staged feed, then push it to agents';
      act.addEventListener('click', () => {
        if (confirm('Serve version ' + v + ' to agents? You will still push it (canary first).'))
          socket.emit('admin_activate_version', v);
      });
      tr.children[1].appendChild(act);
    }
    tb.appendChild(tr);
  });
  if (!(info.versions || []).length) tb.innerHTML = '<tr><td colspan="3" class="muted">No versions archived yet.</td></tr>';
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

document.getElementById('agents-refresh').addEventListener('click', renderAgents);
document.getElementById('agents-add').addEventListener('click', openCreateAgentModal);

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

document.getElementById('ca-copy-code').addEventListener('click', () => {
  const code = document.getElementById('ca-code').textContent;
  navigator.clipboard.writeText(code).then(() => {
    const b = document.getElementById('ca-copy-code');
    b.textContent = 'Copied!';
    setTimeout(() => { b.textContent = 'Copy code'; }, 1800);
  });
});

/* ═══════════════ TRANSFER AGENT ═══════════════ */
// Hand a machine to another support user. It leaves this dashboard and appears
// in theirs. (The other route is on the machine itself: "change code", using an
// installation code issued by the new owner.)
let supportUsers   = [];
let transferAgent  = null;

socket.on('support_users', (list) => { supportUsers = Array.isArray(list) ? list : []; });

function openTransferModal(c) {
  transferAgent = c;
  socket.emit('list_support_users');          // refresh in case a user was added
  document.getElementById('tr-agent-name').textContent = c.id;
  document.getElementById('tr-current').textContent    = c.owner || 'nobody';
  const err = document.getElementById('tr-error');
  err.style.display = 'none';

  const sel = document.getElementById('tr-user');
  sel.innerHTML = '';
  const others = supportUsers.filter(u => u.username !== (c.owner || ''));
  others.forEach(u => {
    const o = document.createElement('option');
    o.value = u.username;
    o.textContent = u.username + (u.role === 'admin' ? ' (admin)' : '');
    sel.appendChild(o);
  });
  const confirmBtn = document.getElementById('tr-confirm');
  confirmBtn.disabled = others.length === 0;
  if (!others.length) {
    err.textContent = 'There is no other user to transfer to. Create one in the Admin Panel first.';
    err.style.display = 'block';
  }
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
});
socket.on('agent_availability_error', (msg) => {
  log('Could not change availability: ' + msg);
  alert('Could not change availability: ' + msg);
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
  unavailable: 'Unavailable',
  offline:     'Offline',
  mine:        'In session with you',
  busy:        'Busy',
  toinstall:   'To install'
};
const STATUS_HINT = {
  available:   'Click to connect',
  unavailable: 'Ask the client to click "Allow Support Access" in their app',
  offline:     'App is closed — it reconnects automatically when opened',
  mine:        'Click to open the session',
  busy:        'Another agent is connected',
  toinstall:   'Share this code with the client — the app asks for it during setup'
};

function renderAgents() {
  const grid  = document.getElementById('agents-grid');
  const empty = document.getElementById('agents-empty');

  const counts = { all: lastClients.length, available: 0, unavailable: 0, offline: 0, toinstall: 0 };
  lastClients.forEach(c => {
    const s = classify(c);
    if (s === 'available') counts.available++;
    else if (s === 'unavailable') counts.unavailable++;
    else if (s === 'offline') counts.offline++;
    else if (s === 'toinstall') counts.toinstall++;
  });
  document.getElementById('count-all').textContent         = counts.all || '';
  document.getElementById('count-available').textContent   = counts.available || '';
  document.getElementById('count-unavailable').textContent = counts.unavailable || '';
  document.getElementById('count-offline').textContent     = counts.offline || '';
  document.getElementById('count-toinstall').textContent   = counts.toinstall || '';

  let list = lastClients;
  if (agentFilter !== 'all') list = list.filter(c => {
    const s = classify(c);
    return agentFilter === 'available' ? (s === 'available' || s === 'mine') : s === agentFilter;
  });
  if (agentSearch) list = list.filter(c => c.id.toLowerCase().includes(agentSearch));

  grid.innerHTML = '';
  empty.style.display = list.length ? 'none' : 'block';

  list.forEach(c => {
    const s = classify(c);
    const connectable = (s === 'available' || s === 'mine');
    // Pending slots can be cleared by any support user; deleting a REAL agent
    // is admin-only (the server enforces this too — mirror it so we don't show
    // a button that silently does nothing).
    const canRemove   = !c.isBusy && targetClientId !== c.id
                        && (s === 'toinstall' || ((s === 'offline' || s === 'unavailable') && agentRole === 'admin'));

    const card = document.createElement('div');
    card.className = 'agent-card' + (connectable ? ' connectable' : '');
    card.title = STATUS_HINT[s];

    const name = document.createElement('div');
    name.className = 'agent-card-name';
    name.textContent = c.id;
    card.appendChild(name);

    if (s === 'toinstall' && c.installCode) {
      const codeEl = document.createElement('div');
      codeEl.className = 'agent-card-code';
      codeEl.textContent = c.installCode;
      codeEl.title = 'Installation code — the client app asks for this during setup';
      card.appendChild(codeEl);
    } else {
      const os = document.createElement('div');
      os.className = 'agent-card-os';
      os.innerHTML = c.platform === 'mac'
        ? '<span class="os-mac">macOS</span>'
        : '<span class="win-logo"><span></span><span></span><span></span><span></span></span>';
      card.appendChild(os);
    }

    // Ownership is only worth showing when it is not simply "me" -- a support
    // user sees nothing but their own agents, so the line would be noise.
    if (c.owner && (agentRole === 'admin' || c.owner !== agentName)) {
      const own = document.createElement('div');
      own.className = 'agent-card-owner';
      own.textContent = 'Assigned: ' + c.owner;
      own.title = 'This agent belongs to ' + c.owner;
      card.appendChild(own);
    }

    const st = document.createElement('div');
    st.className = 'agent-card-status st-' + s;
    st.textContent = s === 'busy' ? 'Busy — ' + c.agentName : STATUS_TEXT[s];
    card.appendChild(st);

    // three-dot menu
    const menuBtn = document.createElement('button');
    menuBtn.className = 'card-menu-btn';
    menuBtn.innerHTML = '&#8942;';
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openMenuFor = (openMenuFor === c.id) ? null : c.id;
      renderAgents();
    });
    card.appendChild(menuBtn);

    const menu = document.createElement('div');
    menu.className = 'card-menu' + (openMenuFor === c.id ? ' open' : '');

    const mConnect = document.createElement('button');
    mConnect.textContent = 'Connect';
    mConnect.disabled = !connectable;
    mConnect.addEventListener('click', (e) => {
      e.stopPropagation();
      openMenuFor = null;
      connectToClient(c.id);
    });
    menu.appendChild(mConnect);

    // Enable / disable support access from the dashboard — the same flag the
    // client's in-app toggle sets. Only meaningful for installed agents.
    if (s !== 'toinstall') {
      const mAvail = document.createElement('button');
      mAvail.textContent = c.available ? 'Disable support access' : 'Enable support access';
      mAvail.addEventListener('click', (e) => {
        e.stopPropagation();
        openMenuFor = null;
        const turningOff = c.available;
        if (turningOff && c.isBusy &&
            !confirm('Disable "' + c.id + '"? This ends the current session and the agent goes Inactive until re-enabled.')) {
          renderAgents(); return;
        }
        socket.emit('set_agent_availability', { clientId: c.id, available: !c.available });
        log((turningOff ? 'Disabling ' : 'Enabling ') + c.id + '…');
      });
      menu.appendChild(mAvail);
    }

    const mTransfer = document.createElement('button');
    mTransfer.textContent = 'Transfer to\u2026';
    mTransfer.addEventListener('click', (e) => {
      e.stopPropagation();
      openMenuFor = null;
      openTransferModal(c);
    });
    menu.appendChild(mTransfer);

    const mRemove = document.createElement('button');
    mRemove.textContent = 'Remove';
    mRemove.className = 'danger';
    mRemove.disabled = !canRemove;
    mRemove.addEventListener('click', (e) => {
      e.stopPropagation();
      openMenuFor = null;
      socket.emit('remove_client', c.id);
      log('Removed ' + c.id + ' from list');
    });
    menu.appendChild(mRemove);
    card.appendChild(menu);

    if (connectable) {
      card.addEventListener('click', () => {
        if (targetClientId === c.id) { openTab('session', tabTitleFor(c.id)); return; }
        connectToClient(c.id);
      });
    }
    grid.appendChild(card);
  });
}

function tabTitleFor(id) {
  return id.length > 22 ? id.slice(0, 21) + '…' : id;
}

/* ═══════════════ SESSION ═══════════════ */
socket.on('session_blocked', (msg) => {
  log('Blocked: ' + msg);
  alert('Cannot connect: ' + msg);
});

function connectToClient(clientId) {
  if (peerConnection) cleanupPeer();
  targetClientId = clientId;
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
  socket.emit('request_connection', targetClientId);
});

socket.on('session_ended', () => {
  log('Session ended (remote side)');
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
  log('WebRTC offer received from client');
  await refreshIce();
  const connStart = Date.now();
  peerConnection = new RTCPeerConnection(iceConfig);

  peerConnection.ontrack = (event) => {
    log(`Video stream received (${Date.now() - connStart}ms)`);
    // Remote desktop wants the freshest frame, not smooth playback: drain the
    // receive jitter buffer instead of letting it hold ~100-200ms of "safety".
    try {
      if ('jitterBufferTarget' in event.receiver) event.receiver.jitterBufferTarget = 0;
      else if ('playoutDelayHint' in event.receiver) event.receiver.playoutDelayHint = 0;
    } catch (_) {}
    if (video.srcObject !== event.streams[0]) {
      video.srcObject = event.streams[0];
      showVideoUI();
      document.getElementById('placeholder').style.display = 'none';
    }
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', { target: data.sender, candidate: event.candidate });
    }
  };

  peerConnection.oniceconnectionstatechange = () =>
    log('ICE state: ' + peerConnection.iceConnectionState);
  peerConnection.onconnectionstatechange = () =>
    log('Connection state: ' + peerConnection.connectionState);

  peerConnection.ondatachannel = (event) => {
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

  await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  socket.emit('answer', { target: data.sender, sdp: answer });
  log('WebRTC answer sent');
});

socket.on('answer', async (data) => {
  if (peerConnection) {
    try { await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp)); }
    catch (e) { log('Answer error: ' + e.message); }
  }
});

socket.on('ice-candidate', async (data) => {
  if (peerConnection) {
    try { await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate)); }
    catch (e) {}
  }
});

/* ═══════════════ SESSION UI HELPERS ═══════════════ */
function setPlaceholder(main, sub) {
  document.getElementById('placeholder-text').textContent = main;
  document.getElementById('placeholder-sub').textContent  = sub || '';
  document.getElementById('placeholder').style.display = 'flex';
}

function showVideoUI() {
  // Controls live in the always-visible session sidebar now — nothing to toggle.
}

function showPlaceholderUI() {
  setPlaceholder('No active session', 'Pick an agent from the Agents tab');
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
  clipPollTimer = setInterval(() => {
    if (dc()) dataChannel.send(JSON.stringify({ type: 'clipboard_request' }));
  }, 1000);
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
document.getElementById('btn-copy').addEventListener('click', () => {
  const url = document.getElementById('copy-url').textContent;
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById('btn-copy');
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
  });
});

document.getElementById('force-reset-btn').addEventListener('click', () => {
  if (confirm('Disconnect ALL active sessions? Clients will need to re-enable access.')) {
    socket.emit('force_reset_all');
  }
});

socket.on('server_reset', () => {
  alert('Server was reset. Page will reload.');
  window.location.reload();
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
  return keyboardEnabled && pointerOverScreen && currentView === 'session' && dc();
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
function flushMove() {
  if (pendingMove && dc()) {
    dataChannel.send(JSON.stringify(pendingMove));
    pendingMove = null;
    moveTimer = setTimeout(flushMove, 16);
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
function buttonName(e) { return e.button === 0 ? 'left' : e.button === 2 ? 'right' : 'middle'; }

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
  pendingMove = Object.assign({ type: 'mousemove' }, normPoint(e));
  if (!moveTimer) flushMove();
});

video.addEventListener('pointerdown', (e) => {
  if (!mouseEnabled || !dc()) return;
  // Capture the pointer so a drag that leaves the picture keeps delivering
  // moves and — crucially — its pointerup. Without it the remote button stayed
  // held whenever a drag ended outside the video.
  try { video.setPointerCapture(e.pointerId); } catch (_) {}
  const button = buttonName(e);
  heldButtons.add(button);
  sendNow(Object.assign({ type: 'mousedown', button }, normPoint(e)));
});

video.addEventListener('pointerup', (e) => {
  const button = buttonName(e);
  if (!heldButtons.has(button)) return;          // not a press we sent (control was off)
  heldButtons.delete(button);
  sendNow(Object.assign({ type: 'mouseup', button }, normPoint(e)));   // drop point of a drag
});

video.addEventListener('pointercancel', releaseAllRemoteButtons);
video.addEventListener('contextmenu', e => e.preventDefault());

video.addEventListener('wheel', (e) => {
  if (!mouseEnabled || !dc()) return;
  e.preventDefault();
  // Normalise to pixels: deltaMode 1 = lines, 2 = pages (Firefox / some
  // mice). The client accumulates and turns 100px into one wheel notch.
  const unit = e.deltaMode === 1 ? 100 / 3 : e.deltaMode === 2 ? 300 : 1;
  sendNow({ type: 'scroll', deltaX: e.deltaX * unit, deltaY: e.deltaY * unit });
}, { passive: false });
