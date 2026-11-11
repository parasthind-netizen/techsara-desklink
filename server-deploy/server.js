const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const app = express();
const server = http.createServer(app);
app.use(express.json());

// ─────────────────────────────────────────────────────────────
// Persistent stores (flat JSON files, atomic writes). A single
// instance so no DB needed; survives restarts and redeploys.
// ─────────────────────────────────────────────────────────────
const DATA_DIR   = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const AGENTS_FILE= path.join(DATA_DIR, 'agents.json');
const CONFIG_FILE= path.join(DATA_DIR, 'config.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return fallback; }
}
function saveJSON(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// users: { username: { passwordHash, salt, role, createdAt, createdBy } }
let users = loadJSON(USERS_FILE, {});
// agents: { name: { available, version, createdAt, createdBy, lastSeen } }
// A PENDING agent (created on the dashboard, not yet installed) additionally
// has { pending: true, installCode: '123456789' } until a client redeems the
// code and registers under that name.
let agents = loadJSON(AGENTS_FILE, {});

// App-wide config (persisted). brandName is the product name agents display;
// the product owner can change it from the dashboard and push it to all agents.
let appConfig = loadJSON(CONFIG_FILE, {});
function persistConfig() { saveJSON(CONFIG_FILE, appConfig); }
function brandName() {
  const n = String(appConfig.brandName || '').trim();
  return n || 'DeskLink';
}

// agents is parsed JSON — own-property lookups only (a clientId like
// "constructor" or "__proto__" must never hit the prototype chain).
function getAgent(name) {
  return Object.prototype.hasOwnProperty.call(agents, name) ? agents[name] : null;
}

function formatInstallCode(c) {
  c = String(c || '');
  return c.length === 9 ? c.slice(0, 3) + '-' + c.slice(3, 6) + '-' + c.slice(6) : c;
}

function persistUsers()  { saveJSON(USERS_FILE, users); }
function persistAgents() { saveJSON(AGENTS_FILE, agents); }

// ── Password hashing (scrypt, no external deps) ──
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Seed the first admin from env (or a default, with a loud warning) ──
(function seedAdmin() {
  const hasAdmin = Object.values(users).some(u => u.role === 'admin');
  if (hasAdmin) return;
  const uname = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
  const pass  = process.env.ADMIN_PASSWORD || 'admin123';
  const { salt, hash } = hashPassword(pass);
  users[uname] = { passwordHash: hash, salt, role: 'admin', createdAt: Date.now(), createdBy: 'system' };
  persistUsers();
  if (!process.env.ADMIN_PASSWORD)
    console.warn('⚠  Seeded default admin "admin"/"admin123" — set ADMIN_PASSWORD and change it.');
  else
    console.log(`Seeded admin user "${uname}" from environment.`);
})();

// users is parsed JSON — a plain property read would also hit Object.prototype
// (e.g. username "constructor"), so lookups must be own-property only.
function getUser(username) {
  return Object.prototype.hasOwnProperty.call(users, username) ? users[username] : null;
}

function createUser(username, password, role, createdBy) {
  username = String(username || '').trim().toLowerCase();
  password = String(password || '').trim();  // pasted passwords often carry stray whitespace
  if (!username || !password) return { error: 'Username and password are required' };
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) return { error: 'Username: 3-32 chars, a-z 0-9 . _ -' };
  if (password.length < 6) return { error: 'Password must be at least 6 characters' };
  if (getUser(username)) return { error: 'User already exists' };
  if (role !== 'admin' && role !== 'support') role = 'support';
  const { salt, hash } = hashPassword(password);
  users[username] = { passwordHash: hash, salt, role, suspended: false, createdAt: Date.now(), createdBy };
  persistUsers();
  return { ok: true };
}

// ── Customers (tenants) ──
// A "customer" is a support-role account with a stable Customer ID (TS-####)
// and a display name. Its agents are already isolated from other customers by
// the per-owner filtering (a customer only ever sees agents it owns). The
// product owner (admin) creates customers, suspends/enables them, and resets
// their passwords from the Owner Console.
function nextCustomerId() {
  let max = 0;
  for (const u of Object.values(users)) {
    const m = /^TS-(\d+)$/.exec(String(u && u.customerId || ''));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return 'TS-' + String(max + 1).padStart(4, '0');
}

// Readable random password (no ambiguous chars like O/0/l/1/I).
function genPassword(len = 10) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[crypto.randomInt(0, alphabet.length)];
  return out;
}

// Normalize a team-member limit: an integer 0..1000; default 5.
function normTeamLimit(v) {
  let n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) n = 5;
  if (n > 1000) n = 1000;
  return n;
}

function createCustomer(displayName, createdBy, teamLimit) {
  displayName = String(displayName || '').trim();
  if (displayName.length < 2 || displayName.length > 60)
    return { error: 'Customer name must be 2-60 characters' };
  const customerId = nextCustomerId();
  const username = customerId.toLowerCase();     // login id = the Customer ID, e.g. ts-0001
  const password = genPassword();
  const { salt, hash } = hashPassword(password);
  users[username] = {
    passwordHash: hash, salt, role: 'support', suspended: false,
    customerId, displayName,
    // A customer is the OWNER of its own tenant; its team members share this
    // tenantId and see the same machines.
    tenantId: customerId, isTenantOwner: true,
    teamLimit: normTeamLimit(teamLimit),         // how many team logins they may create
    createdAt: Date.now(), createdBy
  };
  persistUsers();
  return { ok: true, customerId, username, password, displayName };
}

// ── Team members (a customer's own support people, same tenant) ──
function userTenantId(username) {
  const u = getUser(String(username || '').toLowerCase());
  return u ? String(u.tenantId || u.customerId || '') : '';
}

// Members of a tenant (the owner + any team members), oldest first.
function tenantMembers(tenantId) {
  return Object.entries(users)
    .filter(([, u]) => String(u.tenantId || u.customerId || '') === tenantId && u.role !== 'admin')
    .sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
}

function nextTeamUsername(tenantId) {
  const base = tenantId.toLowerCase();           // e.g. ts-0001
  let n = 2;                                      // the owner is implicitly "1"
  while (getUser(`${base}-u${n}`)) n++;
  return `${base}-u${n}`;
}

function createTeamMember(tenantId, displayName, createdBy) {
  displayName = String(displayName || '').trim();
  if (displayName.length < 2 || displayName.length > 60)
    return { error: 'Team member name must be 2-60 characters' };
  const username = nextTeamUsername(tenantId);
  const password = genPassword();
  const { salt, hash } = hashPassword(password);
  users[username] = {
    passwordHash: hash, salt, role: 'support', suspended: false,
    tenantId, isTenantOwner: false, displayName, createdAt: Date.now(), createdBy
  };
  persistUsers();
  return { ok: true, username, password, displayName, tenantId };
}

function countAgentsOwnedBy(username) {
  let n = 0;
  for (const a of Object.values(agents)) if (a && String(a.owner || '') === username) n++;
  return n;
}

function countAgentsInTenant(tenantId) {
  if (!tenantId) return 0;
  let n = 0;
  for (const a of Object.values(agents))
    if (a && String(a.tenantId || '') === tenantId) n++;
  return n;
}

function publicUserList() {
  return Object.entries(users).map(([username, u]) => {
    const tenantId = String(u.tenantId || u.customerId || '');
    return {
      username, role: u.role, createdAt: u.createdAt, createdBy: u.createdBy || '',
      customerId: u.customerId || '', displayName: u.displayName || '',
      tenantId, isTenantOwner: !!u.isTenantOwner,
      suspended: !!u.suspended,
      agentCount: countAgentsInTenant(tenantId),
      // team members (exclude the owner account itself) and the owner's limit
      teamCount: tenantMembers(tenantId).filter(([, m]) => !m.isTenantOwner).length,
      teamLimit: (u.teamLimit === undefined ? 5 : u.teamLimit)
    };
  });
}

// Reassign targets (owner-only): only customers (tenant owners), never team
// members or the product owner.
function transferUserList() {
  return Object.entries(users)
    .filter(([, u]) => u.role === 'support' && u.isTenantOwner)
    .map(([username, u]) => ({
      username, role: u.role, customerId: u.customerId || '', displayName: u.displayName || ''
    }));
}

// -------------------------------------------------------------
// Agent ownership
// Every agent belongs to exactly one support user. Support users see and
// connect to only their own agents; admins see the whole fleet. A machine is
// handed over either from the dashboard (transfer_agent) or by re-provisioning
// it in the client app with an installation code from the new owner.
// -------------------------------------------------------------
function firstAdmin() {
  const found = Object.entries(users).find(([, u]) => u.role === 'admin');
  return found ? found[0] : '';
}

function agentOwner(name) {
  const entry = getAgent(name);
  return entry ? String(entry.owner || '') : '';
}

// The tenant an agent belongs to (its own stamp, or derived from its owner).
function agentTenantId(name) {
  const entry = getAgent(name);
  if (!entry) return '';
  return String(entry.tenantId || userTenantId(entry.owner) || entry.owner || '');
}

// A support user sees an agent if they're the product owner (admin) OR the
// agent is in their tenant — so every team member of a customer sees all of
// that customer's machines, and nobody sees another customer's.
function canSeeAgent(sup, name) {
  if (!sup) return false;
  if (sup.role === 'admin') return true;
  const t = sup.tenantId || '';
  return !!t && agentTenantId(name) === t;
}

// Agents created before ownership existed have no owner, and an unowned agent
// is invisible to every non-admin. Hand each one to its creator if that user
// still exists, otherwise to an admin, so nothing disappears from the
// dashboard on the first boot after this deploy.
(function migrateAgentOwners() {
  const fallback = firstAdmin();
  let changed = 0;
  for (const entry of Object.values(agents)) {
    if (!entry || entry.owner) continue;
    const creator = String(entry.createdBy || '').toLowerCase();
    entry.owner = (creator && getUser(creator)) ? creator : fallback;
    changed++;
  }
  if (changed) {
    persistAgents();
    console.log(`Ownership migration: assigned an owner to ${changed} agent(s) (fallback "${fallback}")`);
  }
})();

// Give every existing customer (support-role account) a Customer ID + display
// name if it predates this feature, so the Owner Console shows them properly.
(function migrateCustomerIds() {
  let changed = 0;
  // Oldest first, so IDs are assigned in a stable, sensible order.
  const supportUsers = Object.entries(users)
    .filter(([, u]) => u.role === 'support')
    .sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
  for (const [username, u] of supportUsers) {
    if (!u.customerId) { u.customerId = nextCustomerId(); changed++; }
    if (!u.displayName) u.displayName = username;
    if (u.suspended === undefined) u.suspended = false;
    // Pre-team accounts each become the owner of their own tenant.
    if (!u.tenantId) { u.tenantId = u.customerId; changed++; }
    if (u.isTenantOwner === undefined) u.isTenantOwner = true;
    if (u.teamLimit === undefined) { u.teamLimit = 5; changed++; }
  }
  if (changed) { persistUsers(); console.log(`Customer migration: updated ${changed} account field(s)`); }
})();

// Stamp every agent with the tenant it belongs to (= its owner's tenant), so
// isolation and team sharing work by tenant, not by a single username.
(function migrateAgentTenants() {
  let changed = 0;
  for (const a of Object.values(agents)) {
    if (!a || a.tenantId) continue;
    a.tenantId = userTenantId(a.owner) || String(a.owner || '');
    changed++;
  }
  if (changed) { persistAgents(); console.log(`Agent tenant migration: stamped ${changed} agent(s)`); }
})();

// ─────────────────────────────────────────────────────────────
// TURN / STUN — ephemeral credentials via coturn REST (use-auth-secret)
// ─────────────────────────────────────────────────────────────
const TURN_HOST   = process.env.TURN_HOST || '';
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_TTL    = 3600 * 12; // 12h

function iceServers() {
  const list = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];
  if (TURN_HOST) list.push({ urls: `stun:${TURN_HOST}:3478` });
  if (TURN_HOST && TURN_SECRET) {
    const username = (Math.floor(Date.now() / 1000) + TURN_TTL) + ':techsara';
    const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
    list.push({
      urls: [
        `turn:${TURN_HOST}:3478?transport=udp`,
        `turn:${TURN_HOST}:3478?transport=tcp`
      ],
      username, credential
    });
  }
  return list;
}

// ── In-memory live session state ──
const clients   = new Map();  // clientId -> { socketId, available, version }
const supports  = new Map();  // socketId -> { name, role, targetClientId }
const activeSessions = new Map();       // clientId -> supportSocketId
const reconnectTimers = new Map();      // agentName -> { clientId }
const clientReconnectTimers = new Map();// clientId -> { agentSocketId }

// ─────────────────────────────────────────────────────────────
// Auto-update feed (electron-updater generic provider) + rollback archive
// ─────────────────────────────────────────────────────────────
const UPDATES_DIR = path.join(__dirname, 'updates');
const ARCHIVE_DIR = path.join(UPDATES_DIR, 'archive');
// Customer-facing installer names (constant, served by /download/*).
const DL_EXE = 'DeskLink-Setup.exe';
const DL_ZIP = 'DeskLink-Setup.zip';
const DL_DMG = 'DeskLink.dmg';
if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

// Rollout gate state (module scope — resets on server restart, which is fine).
// Per platform: a healthy mac canary must NOT unlock push-to-all for an
// untested Windows build, and a rollback on one platform must not make the
// other platform's pushes carry allowDowngrade.
const pushedCanaries = new Set();                 // clientIds pushed as canary, awaiting a healthy re-register
const canaryHealthy  = { win: false, mac: false };// unlocks push-to-ALL per platform after a canary returns on target
const rollbackMode   = { win: false, mac: false };// a rollback feed → that platform's pushes carry allowDowngrade:true

// ── Per-platform feeds ──
// Windows agents read latest.yml, mac agents latest-mac.yml (electron-updater
// convention). 'win' | 'mac'; anything else (incl. the raw process.platform
// strings clients send) is normalised. Legacy clients send no platform → win.
function normPlatform(p) {
  p = String(p || '').toLowerCase();
  return (p === 'darwin' || p === 'mac' || p === 'macos') ? 'mac' : 'win';
}
function feedYmlName(platform) {
  return normPlatform(platform) === 'mac' ? 'latest-mac.yml' : 'latest.yml';
}

function feedVersion(platform, dir) {
  try {
    const txt = fs.readFileSync(path.join(dir || UPDATES_DIR, feedYmlName(platform)), 'utf8');
    const m = txt.match(/^version:\s*(.+)$/m);
    return m ? m[1].trim() : null;
  } catch (_) { return null; }
}

// The installer filename latest.yml points at (versioned since 1.3.5 —
// constant names collided in the client updater's cache).
function feedExeName(dir) {
  try {
    const txt = fs.readFileSync(path.join(dir || UPDATES_DIR, 'latest.yml'), 'utf8');
    const m = txt.match(/^path:\s*(.+)$/m);
    return m ? m[1].trim() : null;
  } catch (_) { return null; }
}

// Every artifact the mac feed references (per-arch zips, dmgs) — the `url:`
// entries of latest-mac.yml's files list.
function feedMacFiles(dir) {
  try {
    const txt = fs.readFileSync(path.join(dir || UPDATES_DIR, 'latest-mac.yml'), 'utf8');
    const out = [];
    for (const m of txt.matchAll(/^\s*-?\s*url:\s*(.+)$/gm)) {
      const f = m[1].trim();
      if (f && !out.includes(f)) out.push(f);
    }
    return out;
  } catch (_) { return []; }
}

// semver-ish compare: returns 1 if a>b, -1 if a<b, 0 if equal/unknown
function cmpVersion(a, b) {
  if (!a || !b) return 0;
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function listArchivedVersions() {
  try {
    return fs.readdirSync(ARCHIVE_DIR)
      .filter(v => fs.existsSync(path.join(ARCHIVE_DIR, v, 'latest.yml')) ||
                   fs.existsSync(path.join(ARCHIVE_DIR, v, 'latest-mac.yml')))
      .sort((a, b) => cmpVersion(b, a));  // newest first
  } catch (_) { return []; }
}

// Copy the current live feed(s) into archive/<version>/ so they can be rolled
// back to later. Win and mac are archived independently — their live versions
// can differ (e.g. mac ships first at 1.4.0 while win is still 1.3.9).
function archiveLiveVersion() {
  const perPlatform = [
    { yml: 'latest.yml',     version: feedVersion('win'), files: () => ['latest.yml', feedExeName()].filter(Boolean) },
    { yml: 'latest-mac.yml', version: feedVersion('mac'), files: () => ['latest-mac.yml'].concat(feedMacFiles()) },
  ];
  for (const p of perPlatform) {
    if (!p.version) continue;
    const dest = path.join(ARCHIVE_DIR, p.version);
    if (fs.existsSync(path.join(dest, p.yml))) continue;  // already archived
    fs.mkdirSync(dest, { recursive: true });
    for (const f of p.files()) {
      const src = path.join(UPDATES_DIR, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dest, f));
    }
    console.log(`Archived live update version ${p.version} (${p.yml})`);
  }
}

// Make an archived version the live feed (used for rollback OR roll-forward).
// An archive dir may hold the win feed, the mac feed, or both — only the
// platforms it holds are switched; the other platform's live feed is untouched.
function activateVersion(version) {
  const dir = path.join(ARCHIVE_DIR, version);
  const hasWin = fs.existsSync(path.join(dir, 'latest.yml'));
  const hasMac = fs.existsSync(path.join(dir, 'latest-mac.yml'));
  if (!hasWin && !hasMac) return { error: 'Version not found in archive' };
  const currentWin = feedVersion('win');
  const currentMac = feedVersion('mac');
  archiveLiveVersion();  // preserve whatever is live now before overwriting
  // Copy everything the archived version holds — handles both the current
  // versioned naming and the pre-1.3.5 constant-name archives.
  for (const f of fs.readdirSync(dir)) {
    fs.copyFileSync(path.join(dir, f), path.join(UPDATES_DIR, f));
  }
  // Going backward on a switched platform → that platform's pushes carry
  // allowDowngrade. A fresh rollout on a switched platform requires a new canary.
  if (hasWin) { rollbackMode.win = cmpVersion(version, currentWin) < 0; canaryHealthy.win = false; }
  if (hasMac) { rollbackMode.mac = cmpVersion(version, currentMac) < 0; canaryHealthy.mac = false; }
  for (const id of [...pushedCanaries]) {
    const c = clients.get(id);
    const p = normPlatform(c && c.platform);
    if ((p === 'win' && hasWin) || (p === 'mac' && hasMac)) pushedCanaries.delete(id);
  }
  syncDownloadExe();
  syncDownloadDmg();
  ensureDownloadZip();
  const rolledBack = (hasWin && rollbackMode.win) || (hasMac && rollbackMode.mac);
  console.log(`Activated version ${version} (rollback=${rolledBack}, win=${hasWin}, mac=${hasMac})`);
  return { ok: true, version, rollback: rolledBack };
}

// Keep the plain-install download (constant customer-facing name) in sync
// with whatever version the feed currently serves.
function syncDownloadExe() {
  const name = feedExeName();
  if (!name) return;
  const src = path.join(UPDATES_DIR, name);
  if (!fs.existsSync(src)) return;
  const dlDir = path.join(__dirname, 'downloads');
  if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir, { recursive: true });
  const dest = path.join(dlDir, DL_EXE);
  if (fs.existsSync(dest) && fs.statSync(dest).mtimeMs >= fs.statSync(src).mtimeMs) return;
  fs.copyFileSync(src, dest);
  console.log(`Download installer synced to feed version (${name} -> ${DL_EXE})`);
}

// Keep the plain-install mac downloads (constant customer-facing names) in
// sync with whatever version the mac feed currently serves. Both arches are
// published so Intel Macs aren't handed an Apple-Silicon-only build:
//   DeskLink.dmg        → Apple Silicon (arm64), the default on /download/mac
//   DeskLink-intel.dmg  → Intel (x64), served on /download/mac?arch=intel
const DL_DMG_INTEL = 'DeskLink-intel.dmg';
function syncOneDmg(archMatch, destName) {
  const dmgs = feedMacFiles().filter(f => f.endsWith('.dmg'));
  // For arm64 prefer an arm64-named file; for x64 prefer an x64/intel-named
  // one. Fall back to the sole dmg only when exactly one exists (single-arch build).
  let name = dmgs.find(f => archMatch.test(f));
  if (!name && dmgs.length === 1) name = dmgs[0];
  if (!name) return;
  const src = path.join(UPDATES_DIR, name);
  if (!fs.existsSync(src)) return;
  const dlDir = path.join(__dirname, 'downloads');
  if (!fs.existsSync(dlDir)) fs.mkdirSync(dlDir, { recursive: true });
  const dest = path.join(dlDir, destName);
  if (fs.existsSync(dest) && fs.statSync(dest).mtimeMs >= fs.statSync(src).mtimeMs) return;
  fs.copyFileSync(src, dest);
  console.log(`Mac download synced (${name} -> ${destName})`);
}
function syncDownloadDmg() {
  syncOneDmg(/arm64/i, DL_DMG);
  syncOneDmg(/(x64|intel)/i, DL_DMG_INTEL);
}

// On boot, make sure whatever is currently staged is in the archive/history.
archiveLiveVersion();
syncDownloadExe();
syncDownloadDmg();

// ── ZIP wrapper for the installer ──
// Unsigned .exe downloads get flagged by browser/AV heuristics ("virus
// detected"); a ZIP of the same file usually passes. Rebuilt whenever the
// exe in downloads/ is newer than the zip (boot + version activation).
function ensureDownloadZip() {
  const exe = path.join(__dirname, 'downloads', DL_EXE);
  const zip = path.join(__dirname, 'downloads', DL_ZIP);
  try {
    if (!fs.existsSync(exe)) return;
    if (fs.existsSync(zip) && fs.statSync(zip).mtimeMs >= fs.statSync(exe).mtimeMs) return;
    const tmp = zip + '.tmp';
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    execFileSync('zip', ['-j', '-X', tmp, exe], { stdio: 'ignore' });
    fs.renameSync(tmp, zip);
    console.log('Installer ZIP rebuilt for /download/windows-zip');
  } catch (e) {
    console.warn('Installer ZIP build failed:', e.message);
  }
}
ensureDownloadZip();

// ─────────────────────────────────────────────────────────────
// HTTP endpoints
// ─────────────────────────────────────────────────────────────
// ── Routing ──
// Public marketing landing page at / (front door with Download + Log in).
// The support/owner dashboard app lives at /dashboard. Static assets
// (script.js, style.css, download.html, landing.html) are served from the
// dashboard folder at the root path by the static middleware below.
const DASHBOARD_DIR = path.join(__dirname, 'dashboard');
app.get('/', (req, res) => res.sendFile(path.join(DASHBOARD_DIR, 'landing.html')));
app.get(['/dashboard', '/dashboard/', '/app'], (req, res) => res.sendFile(path.join(DASHBOARD_DIR, 'index.html')));
// Serve static assets but NOT index.html at '/' (index:false) — '/' is the
// landing page, set above.
app.use(express.static(DASHBOARD_DIR, { index: false }));

// Auto-update feed. The yml manifests (latest.yml, latest-mac.yml) must never
// be cached — agents must always see the true target version.
app.use('/updates', express.static(UPDATES_DIR, {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.yml')) res.setHeader('Cache-Control', 'no-store');
  }
}));

app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', clients: clients.size, agents: Object.keys(agents).length,
             feedVersion: feedVersion('win'), feedVersionMac: feedVersion('mac'), time: new Date().toISOString() });
});

app.get('/ice', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');   // Electron client fetches this cross-origin
  res.json({ iceServers: iceServers() });
});

// Current product/brand name — a fresh install can read it before its socket
// connects, so the very first screen already shows the owner's brand.
app.get('/branding', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.json({ name: brandName() });
});

// ── Installation-code redemption (client first-run setup) ──
// GET so it stays a CORS "simple request" from the Electron renderer.
// Idempotent: the code stays valid until the client actually registers under
// the agent name (which clears pending) — so a re-run of the installer works.
const redeemAttempts = new Map();  // ip -> { count, windowStart }
app.get('/api/redeem-code', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  // Key on the real socket peer, NOT X-Forwarded-For — XFF is caller-supplied
  // and would let an attacker mint a fresh bucket per request (rate-limit
  // bypass) and grow the Map without bound. The real gate is code verification
  // at register time; this throttle just slows brute force of the endpoint.
  const ip = req.socket.remoteAddress || '?';
  const now = Date.now();
  // Bound the Map: prune expired entries whenever it grows large.
  if (redeemAttempts.size > 5000) {
    for (const [k, v] of redeemAttempts) if (now - v.windowStart > 10 * 60 * 1000) redeemAttempts.delete(k);
  }
  let a = redeemAttempts.get(ip);
  if (!a || now - a.windowStart > 10 * 60 * 1000) a = { count: 0, windowStart: now };
  a.count++;
  redeemAttempts.set(ip, a);
  if (a.count > 60) return res.status(429).json({ error: 'Too many attempts — wait a few minutes and try again' });

  const code = String(req.query.code || '').replace(/\D/g, '');
  if (code.length !== 9) return res.status(400).json({ error: 'Enter the 9-digit code, like 364-630-153' });
  for (const [name, entry] of Object.entries(agents)) {
    if (entry && entry.pending && entry.installCode === code) {
      console.log(`Install code redeemed for agent "${name}" (from ${ip})`);
      return res.json({ ok: true, name });
    }
  }
  console.warn(`Install code redeem FAILED (from ${ip})`);
  res.status(404).json({ error: 'Code not recognized — ask your support agent for a new one' });
});

app.get('/download/windows', (req, res) => {
  // Prefer the installer hosted on this server (all-AWS, permanent). Fall back
  // to GitHub Releases only if the local file isn't present.
  const local = path.join(__dirname, 'downloads', DL_EXE);
  if (fs.existsSync(local)) return res.download(local, DL_EXE);
  // Transition fallback: pre-rebrand installer if the DeskLink one isn't staged yet.
  const legacy = path.join(__dirname, 'downloads', 'TechsaraSupport-Setup.exe');
  if (fs.existsSync(legacy)) return res.download(legacy, DL_EXE);
  res.status(404).send('Installer not available');
});
// ZIP variant — same installer, wrapped so browsers/AV don't block the download.
app.get('/download/windows-zip', (req, res) => {
  const zipPath = path.join(__dirname, 'downloads', DL_ZIP);
  ensureDownloadZip();
  if (fs.existsSync(zipPath)) return res.download(zipPath, DL_ZIP);
  res.redirect('/download/windows');
});
// macOS installer — the DMG synced from the mac update feed. Apple Silicon by
// default; ?arch=intel serves the x64 build. (No ZIP wrapper needed: browsers
// don't flag DMG downloads the way they do unsigned EXEs.)
app.get('/download/mac', (req, res) => {
  syncDownloadDmg();
  const intel = String(req.query.arch || '').toLowerCase() === 'intel';
  const name = intel ? DL_DMG_INTEL : DL_DMG;
  const local = path.join(__dirname, 'downloads', name);
  if (fs.existsSync(local)) return res.download(local, name);
  // If the requested arch isn't staged but the other is (single-arch build),
  // fall back to whatever DMG exists rather than 404.
  const alt = path.join(__dirname, 'downloads', intel ? DL_DMG : DL_DMG_INTEL);
  if (fs.existsSync(alt)) return res.download(alt, path.basename(alt));
  res.status(404).send('Mac installer not available yet — ask your support team');
});

app.get('/debug', (req, res) => {
  // Discloses usernames, machine names and live session mappings — gate it
  // behind a shared key so it isn't world-readable on a public deployment.
  // Set DEBUG_KEY in the environment; without it, /debug is disabled.
  if (!process.env.DEBUG_KEY || req.query.key !== process.env.DEBUG_KEY) {
    return res.status(404).send('Not found');
  }
  res.json({
    clients: Array.from(clients.entries()).map(([id, c]) => ({ id, available: c.available, online: !!c.socketId })),
    supports: Array.from(supports.entries()).map(([sid, s]) => ({ sid, name: s.name, role: s.role, target: s.targetClientId })),
    activeSessions: Array.from(activeSessions.entries()),
    registeredAgents: Object.keys(agents).length,
    users: Object.keys(users).length,
    turn: !!(TURN_HOST && TURN_SECRET),
    serverTime: new Date().toISOString()
  });
});

const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

// ── Helpers ──
function getSessionAgentName(clientId) {
  const sid = activeSessions.get(clientId);
  if (sid && supports.has(sid)) return supports.get(sid).name;
  for (const [name, p] of reconnectTimers) if (p.clientId === clientId) return name;
  return null;
}

function endSession(clientId, reason) {
  const supportSocketId = activeSessions.get(clientId);
  activeSessions.delete(clientId);

  // NOTE: availability is persistent now — a session ending does NOT make the
  // agent unavailable. It stays available until the client disables it or an
  // admin deletes it. (Requested: unattended, always-on support desks.)
  if (supportSocketId && supports.has(supportSocketId)) {
    const sup = supports.get(supportSocketId);
    if (sup) sup.targetClientId = null;
    io.to(supportSocketId).emit('session_ended', { clientId, reason });
  }
  const clientData = clients.get(clientId);
  if (clientData) io.to(clientData.socketId).emit('session_ended', { reason });

  console.log(`Session ended: ${clientId} — reason: ${reason}`);
  broadcastClients();
}

function broadcastClients() {
  // Per-platform staged targets — a mac agent is only "update available"
  // against the mac feed, and vice versa.
  const targets = { win: feedVersion('win'), mac: feedVersion('mac') };
  const targetFor = (platform) => targets[normPlatform(platform)];
  const clientList = [];
  const seen = new Set();
  for (const [id, c] of clients) {
    seen.add(id);
    const entry = getAgent(id);
    const version = c.version || (entry && entry.version) || 'unknown';
    const platform = normPlatform(c.platform || (entry && entry.platform));
    const target = targetFor(platform);
    clientList.push({
      id,
      owner: (entry && entry.owner) || '',
      tenantId: agentTenantId(id),
      available: c.available,
      online: !!c.socketId,
      isBusy: activeSessions.has(id),
      agentName: getSessionAgentName(id),
      version,
      platform,
      updateAvailable: !!(target && version !== 'unknown' && version !== target)
    });
  }
  // Persistent registry: agents that haven't connected since the last server
  // restart (shown Offline) and dashboard-created agents awaiting install
  // (shown "To install", with their installation code).
  for (const [id, entry] of Object.entries(agents)) {
    if (seen.has(id) || !entry) continue;
    const version = entry.version || 'unknown';
    const platform = normPlatform(entry.platform);
    const target = targetFor(platform);
    clientList.push({
      id,
      owner: entry.owner || '',
      tenantId: agentTenantId(id),
      available: !!entry.available,
      online: false,
      isBusy: false,
      agentName: null,
      version,
      platform,
      updateAvailable: !!(target && !entry.pending && version !== 'unknown' && version !== target),
      pending: !!entry.pending,
      installCode: entry.pending ? formatInstallCode(entry.installCode) : undefined
    });
  }
  // Agents are private to their TENANT -- every team member of a customer is
  // sent that customer's machines; admins (product owner) get the whole fleet.
  for (const [socketId, sup] of supports) {
    io.to(socketId).emit('clients_list',
      sup.role === 'admin' ? clientList : clientList.filter(c => c.tenantId && c.tenantId === sup.tenantId));
  }
}

function requireAdmin(socket) {
  const sup = supports.get(socket.id);
  return sup && sup.role === 'admin';
}

// ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  socket.on('register', (data) => {
    // ── CLIENT (the machine being supported) ──
    if (data.type === 'client') {
      const clientId = String(data.clientId || '').trim();
      // Only machines the support team created (via installation code) — or
      // that were already registered before this gate existed — may register.
      const persisted = getAgent(clientId);
      if (!clientId || !persisted) {
        console.warn(`Register REJECTED for unknown agent "${clientId}"`);
        socket.emit('register_rejected',
          'This computer is not set up with the support team. Enter a valid installation code.');
        return;
      }
      const wasPending = !!persisted.pending;
      const appVersion = String(data.appVersion || 'unknown');
      // 1.4.0+ clients report their platform; older ones are all Windows. The
      // persisted value covers a mac client briefly re-registering from a
      // pre-platform payload (shouldn't happen, but harmless to keep).
      const platform   = normPlatform(data.platform || persisted.platform);
      const givenCode   = String(data.installCode || '').replace(/\D/g, '');
      const givenSecret = String(data.secret || '');

      // ── Bind authentication ──
      // Pending slot: the client MUST present the matching installation code
      // (it has it — it just redeemed it). This stops anyone binding a slot by
      // guessing its human-readable name.
      if (wasPending) {
        if (givenCode !== String(persisted.installCode || '')) {
          console.warn(`Register REJECTED for pending "${clientId}" — bad/absent install code`);
          socket.emit('register_rejected',
            'Installation code did not match. Ask your support agent for a fresh code.');
          return;
        }
      } else if (persisted.secret) {
        // Real agent that already has a per-machine secret: require it. Guards
        // against a stranger re-registering under a known agent name. (A secret
        // only exists once a 1.3.0+ client has connected, so 1.2.0 clients that
        // never had one are never locked out — see issuance below.)
        if (givenSecret !== persisted.secret) {
          console.warn(`Register REJECTED for "${clientId}" — secret mismatch (v=${appVersion})`);
          socket.emit('register_rejected',
            'This computer could not be verified. Enter a new installation code to set it up again.');
          return;
        }
      }

      // Issue a per-machine secret the first time a capable (1.3.0+) client
      // binds — whether a fresh code redemption or a legacy agent upgrading.
      // Trust-on-first-use: we can't retro-secure 1.2.0, but every machine
      // gets a secret the moment it runs code that can store one.
      let secret = persisted.secret;
      if (!secret && cmpVersion(appVersion, '1.3.0') >= 0) {
        secret = crypto.randomBytes(24).toString('hex');
        socket.emit('client_bound', { secret });   // 1.2.0 ignores this; 1.3.0 stores it
      }

      // Restore persisted availability so a restart / reconnect keeps the
      // agent visible & available until explicitly disabled or deleted.
      // A just-installed (pending) agent starts unavailable until the client
      // clicks "Enable Support Access".
      // A machine that has just redeemed a valid installation code is meant to
      // be supportable straight away, so it comes up Active -- the support user
      // who issued the code sees it online without anyone at the desk clicking
      // Enable. Older clients have no such notion and still start disabled.
      const available = wasPending ? (cmpVersion(appVersion, '1.3.2') >= 0) : !!persisted.available;
      clients.set(clientId, { socketId: socket.id, available, version: appVersion, platform });
      socket.clientId = clientId;
      agents[clientId] = {
        available, version: appVersion, secret, platform,
        owner: persisted.owner || '',
        createdAt: persisted.createdAt || Date.now(),
        createdBy: persisted.createdBy,
        lastSeen: Date.now()
      };  // note: drops pending/installCode — the code is consumed by this bind
      persistAgents();
      if (wasPending) console.log(`Agent "${clientId}" completed installation — code verified & bound`);
      console.log(`Client registered: ${clientId} (available=${available}, v=${appVersion}, ${platform})`);

      // The SERVER is authoritative for availability: the agent stays whatever
      // it was last set to (by the in-app toggle OR the dashboard) across
      // every close/kill/reboot/reconnect. Tell the client the authoritative
      // value so it converges — this is what makes a dashboard enable/disable
      // stick even after the client restarts.
      socket.emit('availability_state', { available });
      // Tell the agent the current product name so it displays the owner's brand.
      socket.emit('branding', { name: brandName() });

      // Canary health: an agent we pushed that comes back on ITS platform's
      // feed version unlocks push-to-all FOR THAT PLATFORM only.
      if (pushedCanaries.has(clientId) && appVersion !== 'unknown' && appVersion === feedVersion(platform)) {
        pushedCanaries.delete(clientId);
        canaryHealthy[platform] = true;
        for (const [sid, s] of supports) if (s.role === 'admin')
          io.to(sid).emit('canary_healthy', { clientId, version: appVersion, platform });
        console.log(`Canary ${clientId} healthy on ${appVersion} (${platform}) — push-to-all unlocked for ${platform}`);
      }

      if (clientReconnectTimers.has(clientId)) {
        const preserved = clientReconnectTimers.get(clientId);
        clientReconnectTimers.delete(clientId);
        const agentSocketId = preserved.agentSocketId;
        if (agentSocketId && supports.has(agentSocketId)) {
          const sup = supports.get(agentSocketId);
          activeSessions.set(clientId, agentSocketId);
          io.to(socket.id).emit('support_request', { supportId: agentSocketId, agentName: sup.name, restored: true });
          io.to(agentSocketId).emit('client_reconnected', { clientId });
          console.log(`Client ${clientId} reconnected — session with ${sup.name} restored`);
        }
      } else if (activeSessions.has(clientId)) {
        const agentSocketId = activeSessions.get(clientId);
        if (supports.has(agentSocketId)) {
          const sup = supports.get(agentSocketId);
          io.to(socket.id).emit('support_request', { supportId: agentSocketId, agentName: sup.name, restored: true });
          io.to(agentSocketId).emit('client_reconnected', { clientId });
          console.log(`Client ${clientId} re-registered mid-session — WebRTC restart sent`);
        }
      }
      broadcastClients();
      return;
    }

    // ── SUPPORT / ADMIN (dashboard user) ──
    if (data.type === 'support') {
      const username = String(data.username || data.name || '').trim().toLowerCase();
      const password = String(data.password || '');
      const user = getUser(username);
      // Accept the password verbatim OR trimmed — accounts created before
      // trimming may have stored edge whitespace, and typed ones may carry it.
      const ok = user && (verifyPassword(password, user.salt, user.passwordHash) ||
                          (password !== password.trim() && verifyPassword(password.trim(), user.salt, user.passwordHash)));
      if (!ok) {
        const from = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || '?';
        console.warn(`Login FAILED for "${username}" — ${user ? 'wrong password' : 'no such user'} (from ${from})`);
        return socket.emit('login_error', 'Invalid username or password');
      }
      // Suspended customers cannot log in until the product owner re-enables them.
      if (user.suspended) {
        console.warn(`Login BLOCKED for suspended account "${username}"`);
        return socket.emit('login_error', 'This account is suspended. Please contact support@techsarasolutions.com.');
      }
      const agentName = username;
      const role = user.role;
      const tenantId = String(user.tenantId || user.customerId || '');
      const isTenantOwner = !!user.isTenantOwner;
      const loginInfo = {
        username: agentName, role,
        customerId: user.customerId || '', displayName: user.displayName || '',
        tenantId, isTenantOwner
      };
      const sessionBase = { name: agentName, role, tenantId, isTenantOwner };

      // Grace-period reconnect: restore a preserved session
      if (reconnectTimers.has(agentName)) {
        const pending = reconnectTimers.get(agentName);
        reconnectTimers.delete(agentName);
        const clientId = pending.clientId;
        supports.set(socket.id, { ...sessionBase, targetClientId: clientId });
        activeSessions.set(clientId, socket.id);
        socket.emit('login_success', loginInfo);
        socket.emit('session_restored', { clientId });
        const clientData = clients.get(clientId);
        if (clientData) io.to(clientData.socketId).emit('support_request', { supportId: socket.id, agentName });
        console.log(`Support ${agentName} reconnected — session with ${clientId} restored`);
        broadcastClients();
        return;
      }

      // Clear stale entries for the same username
      for (const [sid, sup] of supports.entries()) {
        if (sup.name === agentName && sid !== socket.id) {
          if (sup.targetClientId) activeSessions.delete(sup.targetClientId);
          supports.delete(sid);
        }
      }

      supports.set(socket.id, { ...sessionBase, targetClientId: null });
      console.log(`Support registered: ${agentName} (${role}${isTenantOwner ? ', tenant owner' : ''}, tenant ${tenantId})`);
      socket.emit('login_success', loginInfo);
      broadcastClients();
      return;
    }
  });

  // ── Client availability (in-app Enable/Disable toggle) — persisted ──
  socket.on('set_availability', (data) => {
    const clientData = clients.get(socket.clientId);
    if (!clientData) return;
    clientData.available = !!data.available;
    if (agents[socket.clientId]) {
      agents[socket.clientId].available = clientData.available;
      agents[socket.clientId].lastSeen = Date.now();
      persistAgents();
    }
    console.log(`Client ${socket.clientId} availability: ${clientData.available}`);
    broadcastClients();
  });

  // ── Dashboard availability toggle (support/admin) — persisted ──
  // Lets the support team enable or disable an agent's support access from the
  // dashboard, the same flag the client's in-app Enable/Disable sets. It sticks
  // across restarts because the value is persisted in agents.json and pushed to
  // the client (which updates its own saved flag) via availability_state.
  socket.on('set_agent_availability', (data) => {
    const sup = supports.get(socket.id);
    if (!sup) return;
    const clientId = String((data && data.clientId) || '').trim();
    const available = !!(data && data.available);
    const entry = getAgent(clientId);
    if (!entry) return socket.emit('agent_availability_error', 'Agent not found');
    if (entry.pending) return socket.emit('agent_availability_error', 'This agent has not completed installation yet');
    if (!canSeeAgent(sup, clientId)) return socket.emit('agent_availability_error', 'That agent is not yours');
    // Persist first so an offline agent adopts the new value when it reconnects.
    entry.available = available;
    entry.lastSeen = Date.now();
    persistAgents();
    const clientData = clients.get(clientId);
    if (clientData) {
      clientData.available = available;
      // Push the authoritative value to the live client so it updates its UI
      // and its own saved flag; if we're disabling a live session, end it.
      if (clientData.socketId) io.to(clientData.socketId).emit('availability_state', { available });
      if (!available && activeSessions.has(clientId)) endSession(clientId, 'disabled_by_support');
    }
    console.log(`AUDIT set_agent_availability "${clientId}" -> ${available} by ${sup.name}`);
    socket.emit('agent_availability_ok', { clientId, available });
    broadcastClients();
  });

  // ── Team (a customer's own support people within their organization) ──
  function sendTeam(socket, sup) {
    const members = tenantMembers(sup.tenantId).map(([username, u]) => ({
      username, displayName: u.displayName || username,
      isTenantOwner: !!u.isTenantOwner, suspended: !!u.suspended,
      online: Array.from(supports.values()).some(s => s.name === username)
    }));
    socket.emit('team_list', members);
  }

  socket.on('team_list', () => {
    const sup = supports.get(socket.id);
    if (!sup || sup.role === 'admin' || !sup.tenantId) return;
    sendTeam(socket, sup);
  });

  // Create a login for another support person in the same organization. Only
  // the customer's own owner account (the one the product owner issued) may do
  // this — a team member cannot mint more team members.
  socket.on('team_create', (data) => {
    const sup = supports.get(socket.id);
    if (!sup || sup.role === 'admin' || !sup.tenantId) return;
    if (!sup.isTenantOwner) return socket.emit('team_error', 'Only your main account can add team members');
    // Enforce the per-customer team-member limit set by the product owner.
    const me = getUser(sup.name);
    const limit = normTeamLimit(me && me.teamLimit !== undefined ? me.teamLimit : 5);
    const current = tenantMembers(sup.tenantId).filter(([, u]) => !u.isTenantOwner).length;
    if (current >= limit)
      return socket.emit('team_error', limit === 0
        ? 'Your plan does not include team members. Contact support@techsarasolutions.com to enable them.'
        : `You have reached your team member limit (${limit}). Contact support@techsarasolutions.com to increase it.`);
    const result = createTeamMember(sup.tenantId, data && data.displayName, sup.name);
    if (result.error) return socket.emit('team_error', result.error);
    console.log(`AUDIT team_create ${result.username} ("${result.displayName}") in ${sup.tenantId} by ${sup.name}`);
    socket.emit('team_member_created', { username: result.username, password: result.password, displayName: result.displayName });
    sendTeam(socket, sup);
  });

  socket.on('team_reset_password', (data) => {
    const sup = supports.get(socket.id);
    if (!sup || sup.role === 'admin' || !sup.isTenantOwner) return socket.emit('team_error', 'Not allowed');
    const uname = String((data && data.username) || '').toLowerCase();
    const u = getUser(uname);
    if (!u || String(u.tenantId || '') !== sup.tenantId || u.isTenantOwner)
      return socket.emit('team_error', 'That team member is not in your organization');
    const newPassword = genPassword();
    const { salt, hash } = hashPassword(newPassword);
    u.salt = salt; u.passwordHash = hash; persistUsers();
    for (const [sid, s] of supports.entries()) if (s.name === uname) {
      io.to(sid).emit('force_logout', 'Your password was reset. Please log in again with the new password.');
      supports.delete(sid);
    }
    console.log(`AUDIT team_reset_password ${uname} by ${sup.name}`);
    socket.emit('team_password_reset', { username: uname, displayName: u.displayName || uname, password: newPassword });
    sendTeam(socket, sup);
  });

  socket.on('team_remove', (data) => {
    const sup = supports.get(socket.id);
    if (!sup || sup.role === 'admin' || !sup.isTenantOwner) return socket.emit('team_error', 'Not allowed');
    const uname = String((data && data.username) || '').toLowerCase();
    const u = getUser(uname);
    if (!u || String(u.tenantId || '') !== sup.tenantId || u.isTenantOwner || uname === sup.name)
      return socket.emit('team_error', 'That team member is not in your organization');
    delete users[uname]; persistUsers();
    for (const [sid, s] of supports.entries()) if (s.name === uname) {
      if (s.targetClientId && activeSessions.has(s.targetClientId)) endSession(s.targetClientId, 'team_member_removed');
      io.to(sid).emit('force_logout', 'Your access was removed by your organization.');
      supports.delete(sid);
    }
    console.log(`AUDIT team_remove ${uname} by ${sup.name}`);
    socket.emit('team_ok', 'Team member removed');
    sendTeam(socket, sup);
  });

  socket.on('request_connection', (clientId) => {
    const support = supports.get(socket.id);
    if (!support) return;
    // The agent list is filtered per user, but this event is not -- check
    // ownership here too, or a crafted emit would reach anyone's machine.
    if (!canSeeAgent(support, clientId))
      return socket.emit('session_blocked', 'This agent belongs to another support user');
    const clientData = clients.get(clientId);
    if (!clientData || !clientData.available) {
      return socket.emit('session_blocked', 'Agent is not enabled for support access');
    }
    const existingSocketId = activeSessions.get(clientId);
    if (existingSocketId && existingSocketId !== socket.id) {
      const existingAgent = supports.get(existingSocketId);
      if (existingAgent && existingAgent.name !== support.name) {
        return socket.emit('session_blocked', `Client is busy with ${existingAgent.name}`);
      }
    }
    activeSessions.set(clientId, socket.id);
    support.targetClientId = clientId;
    io.to(clientData.socketId).emit('support_request', { supportId: socket.id, agentName: support.name });
    console.log(`Session started: ${support.name} -> ${clientId}`);
    broadcastClients();
  });

  socket.on('end_session', (clientId) => {
    // Only a logged-in support user may end a session, and only the one who
    // owns it (or an admin) — otherwise any anonymous socket could tear down
    // live sessions by guessing agent names.
    const sup = supports.get(socket.id);
    if (!sup) return;
    const owner = activeSessions.get(clientId);
    if (owner && owner !== socket.id && sup.role !== 'admin') return;
    endSession(clientId, 'agent_ended');
  });

  // ── Create a new agent slot with an installation code (any support user) ──
  socket.on('create_agent_slot', (data) => {
    const sup = supports.get(socket.id);
    if (!sup) return;
    const name = String((data && data.name) || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{1,38}$/.test(name))
      return socket.emit('agent_slot_error', 'Name must be 2-39 characters: letters, digits, space, . _ -');
    if (name === '__proto__' || name === 'constructor' || name === 'prototype')
      return socket.emit('agent_slot_error', 'That name is not allowed');
    if (getAgent(name) || clients.has(name))
      return socket.emit('agent_slot_error', 'An agent with this name already exists');
    let code;
    do { code = String(crypto.randomInt(100000000, 1000000000)); }
    while (Object.values(agents).some(a => a && a.pending && a.installCode === code));
    agents[name] = { pending: true, installCode: code, available: false, version: 'unknown', createdAt: Date.now(), createdBy: sup.name, owner: sup.name, tenantId: sup.tenantId || userTenantId(sup.name), lastSeen: null };
    persistAgents();
    console.log(`Agent slot "${name}" created by ${sup.name} (code ${formatInstallCode(code)})`);
    socket.emit('agent_slot_created', { name, code: formatInstallCode(code) });
    broadcastClients();
  });

  // -- Reassign a machine to a different customer (PRODUCT OWNER only) --
  // For strict tenant isolation a customer can NOT push a machine into another
  // customer's dashboard; only the product owner moves machines between
  // customers. Any live session on it ends first.
  socket.on('transfer_agent', (data) => {
    if (!requireAdmin(socket)) return socket.emit('agent_transfer_error', 'Only the product owner can reassign a machine');
    const sup = supports.get(socket.id);
    const clientId = String((data && data.clientId) || '').trim();
    const to = String((data && data.to) || '').trim().toLowerCase();
    const entry = getAgent(clientId);
    if (!entry) return socket.emit('agent_transfer_error', 'Agent not found');
    if (!getUser(to)) return socket.emit('agent_transfer_error', 'No such customer');
    if (String(entry.owner || '') === to)
      return socket.emit('agent_transfer_error', `${clientId} already belongs to ${to}`);
    if (activeSessions.has(clientId)) endSession(clientId, 'agent_transferred');
    entry.owner = to;
    entry.tenantId = userTenantId(to) || to;   // move it into the new customer's tenant
    persistAgents();
    console.log(`AUDIT transfer_agent "${clientId}": ${sup.name} -> ${to}`);
    socket.emit('agent_transfer_ok', { clientId, to });
    broadcastClients();
  });

  // List customers for the transfer picker — PRODUCT OWNER only, so a customer
  // can never enumerate other customers (tenant isolation).
  socket.on('list_support_users', () => {
    if (!requireAdmin(socket)) return;
    socket.emit('support_users', transferUserList());
  });

  // ── Admin: user management ──
  socket.on('admin_list_users', () => {
    if (!requireAdmin(socket)) return;
    socket.emit('admin_users', publicUserList());
  });

  socket.on('admin_create_user', (data) => {
    if (!requireAdmin(socket)) return;
    const me = supports.get(socket.id).name;
    const result = createUser(data.username, data.password, data.role, me);
    if (result.error) return socket.emit('admin_error', result.error);
    console.log(`Admin ${me} created user ${data.username} (${data.role})`);
    socket.emit('admin_ok', `User "${String(data.username).toLowerCase()}" created`);
    socket.emit('admin_users', publicUserList());
  });

  // ── Owner console: customer lifecycle ──────────────────────────
  // Create a customer (tenant): generates a Customer ID + login password to
  // hand over. The owner reads these out to the customer; email delivery is
  // out of band (the customer reached us at support@techsarasolutions.com).
  socket.on('admin_create_customer', (data) => {
    if (!requireAdmin(socket)) return;
    const me = supports.get(socket.id).name;
    const result = createCustomer(data && data.displayName, me, data && data.teamLimit);
    if (result.error) return socket.emit('admin_error', result.error);
    console.log(`AUDIT create_customer ${result.customerId} ("${result.displayName}") by ${me}`);
    // The one-time password is sent ONLY to the creating owner's socket.
    socket.emit('customer_created', {
      customerId: result.customerId, username: result.username,
      password: result.password, displayName: result.displayName
    });
    socket.emit('admin_ok', `Customer ${result.customerId} created`);
    socket.emit('admin_users', publicUserList());
  });

  // ── App branding (product owner only) ──
  // Set the product name shown inside every agent, and push it live to all
  // connected agents. New/reconnecting agents also receive it on register.
  socket.on('admin_set_brand', (data) => {
    if (!requireAdmin(socket)) return;
    const name = String((data && data.name) || '').trim().slice(0, 40);
    if (name.length < 2) return socket.emit('admin_error', 'App name must be 2-40 characters');
    appConfig.brandName = name;
    persistConfig();
    // Live-update every connected agent.
    let n = 0;
    for (const c of clients.values()) if (c.socketId) { io.to(c.socketId).emit('branding', { name }); n++; }
    console.log(`AUDIT set_brand "${name}" by ${supports.get(socket.id).name} -> ${n} live agent(s)`);
    socket.emit('admin_ok', `App name set to "${name}" and pushed to ${n} online agent(s)`);
    for (const [sid, s] of supports) if (s.role === 'admin') io.to(sid).emit('admin_brand', { name });
  });

  socket.on('admin_get_brand', () => {
    if (!requireAdmin(socket)) return;
    socket.emit('admin_brand', { name: brandName() });
  });

  // Change a customer's team-member limit at any time (product owner only).
  socket.on('admin_set_team_limit', (data) => {
    if (!requireAdmin(socket)) return;
    const uname = String((data && data.username) || '').toLowerCase();
    const u = getUser(uname);
    if (!u || !u.isTenantOwner) return socket.emit('admin_error', 'Customer not found');
    u.teamLimit = normTeamLimit(data && data.teamLimit);
    persistUsers();
    console.log(`AUDIT set_team_limit "${uname}" -> ${u.teamLimit} by ${supports.get(socket.id).name}`);
    socket.emit('admin_ok', `Team limit for "${u.customerId || uname}" set to ${u.teamLimit}`);
    socket.emit('admin_users', publicUserList());
  });

  // Suspend / re-enable a customer. A suspended customer cannot log in and any
  // live dashboard session is kicked. Their agents and data are untouched.
  socket.on('admin_suspend_user', (data) => {
    if (!requireAdmin(socket)) return;
    const uname = String((data && data.username) || '').toLowerCase();
    const suspend = !!(data && data.suspended);
    const me = supports.get(socket.id).name;
    const u = getUser(uname);
    if (!u) return socket.emit('admin_error', 'Customer not found');
    if (uname === me) return socket.emit('admin_error', 'You cannot suspend your own account');
    if (u.role === 'admin') return socket.emit('admin_error', 'Cannot suspend an owner/admin account');
    // Suspending a customer suspends the WHOLE organization (owner + every team
    // member), so a blocked customer can't just log in as a teammate.
    const tenantId = String(u.tenantId || u.customerId || '');
    const affected = tenantId ? tenantMembers(tenantId).map(([n]) => n) : [uname];
    for (const n of affected) { if (users[n]) users[n].suspended = suspend; }
    persistUsers();
    if (suspend) {
      for (const [sid, s] of supports.entries()) {
        if (affected.includes(s.name)) {
          if (s.targetClientId && activeSessions.has(s.targetClientId)) endSession(s.targetClientId, 'owner_suspended');
          io.to(sid).emit('force_logout', 'Your account has been suspended. Contact support@techsarasolutions.com.');
          supports.delete(sid);
        }
      }
    }
    console.log(`AUDIT ${suspend ? 'suspend' : 'enable'}_customer "${uname}" (tenant ${tenantId}, ${affected.length} account(s)) by ${me}`);
    socket.emit('admin_ok', `Customer "${u.customerId || uname}" ${suspend ? 'suspended' : 're-enabled'}`);
    socket.emit('admin_users', publicUserList());
    broadcastClients();
  });

  // Reset a customer's dashboard password to a fresh generated one, returned to
  // the owner to hand over. (Owner can't read the old one — it's hashed.)
  socket.on('admin_reset_password', (data) => {
    if (!requireAdmin(socket)) return;
    const uname = String((data && data.username) || '').toLowerCase();
    const me = supports.get(socket.id).name;
    const u = getUser(uname);
    if (!u) return socket.emit('admin_error', 'Customer not found');
    const newPassword = genPassword();
    const { salt, hash } = hashPassword(newPassword);
    u.salt = salt; u.passwordHash = hash;
    persistUsers();
    // Force the customer to re-login with the new password.
    for (const [sid, s] of supports.entries()) {
      if (s.name === uname) {
        if (s.targetClientId && activeSessions.has(s.targetClientId)) endSession(s.targetClientId, 'password_reset');
        io.to(sid).emit('force_logout', 'Your password was reset. Please log in again with the new password.');
        supports.delete(sid);
      }
    }
    console.log(`AUDIT reset_password "${uname}" by ${me}`);
    socket.emit('password_reset_ok', { username: uname, customerId: u.customerId || '', displayName: u.displayName || '', password: newPassword });
    socket.emit('admin_ok', `Password for "${u.customerId || uname}" reset`);
  });

  socket.on('admin_delete_user', (data) => {
    if (!requireAdmin(socket)) return;
    const uname = String(data.username || '').toLowerCase();
    const me = supports.get(socket.id).name;
    if (!getUser(uname)) return socket.emit('admin_error', 'User not found');
    if (uname === me) return socket.emit('admin_error', 'You cannot delete your own account');
    const target = users[uname];
    if (target.role === 'admin' && Object.values(users).filter(u => u.role === 'admin').length <= 1)
      return socket.emit('admin_error', 'Cannot delete the last admin');
    // Deleting a customer deletes the WHOLE organization (owner + team members)
    // and moves that organization's machines to the product owner.
    const tenantId = String(target.tenantId || target.customerId || '');
    const toDelete = (tenantId && target.role !== 'admin')
      ? tenantMembers(tenantId).map(([n]) => n)
      : [uname];
    for (const n of toDelete) delete users[n];
    persistUsers();
    let moved = 0;
    for (const entry of Object.values(agents)) {
      if (!entry) continue;
      const inTenant = tenantId ? String(entry.tenantId || userTenantId(entry.owner)) === tenantId : (String(entry.owner || '') === uname);
      if (inTenant) { entry.owner = me; entry.tenantId = userTenantId(me) || me; moved++; }
    }
    if (moved) { persistAgents(); console.log(`Reassigned ${moved} agent(s) from tenant ${tenantId || uname} to ${me}`); }
    for (const [sid, sup] of supports.entries()) {
      if (toDelete.includes(sup.name)) { io.to(sid).emit('force_logout', 'Your account was removed'); supports.delete(sid); }
    }
    console.log(`Admin ${me} deleted customer ${uname} (${toDelete.length} account(s))`);
    socket.emit('admin_ok', `Customer "${uname}" deleted` + (moved ? ` -- ${moved} machine(s) moved to you` : ''));
    socket.emit('admin_users', publicUserList());
    broadcastClients();
  });

  socket.on('admin_set_role', (data) => {
    if (!requireAdmin(socket)) return;
    const uname = String(data.username || '').toLowerCase();
    if (!getUser(uname)) return socket.emit('admin_error', 'User not found');
    const role = data.role === 'admin' ? 'admin' : 'support';
    if (users[uname].role === 'admin' && role === 'support' &&
        Object.values(users).filter(u => u.role === 'admin').length <= 1)
      return socket.emit('admin_error', 'Cannot demote the last admin');
    users[uname].role = role;
    persistUsers();
    socket.emit('admin_ok', `${uname} is now ${role}`);
    socket.emit('admin_users', publicUserList());
  });

  // ── Admin: auto-update rollout ──────────────────────────────
  function feedInfo() {
    return {
      active: feedVersion('win'), activeMac: feedVersion('mac'),
      versions: listArchivedVersions(),
      // Aggregate booleans for the existing dashboard controls, plus the
      // per-platform detail so the UI can explain which platform is unlocked.
      rollbackMode:     rollbackMode.win || rollbackMode.mac,
      rollbackWin:      rollbackMode.win,
      rollbackMac:      rollbackMode.mac,
      canaryHealthy:    canaryHealthy.win || canaryHealthy.mac,
      canaryHealthyWin: canaryHealthy.win,
      canaryHealthyMac: canaryHealthy.mac
    };
  }

  socket.on('admin_feed_info', () => {
    if (!requireAdmin(socket)) return;
    socket.emit('admin_feed', feedInfo());
  });

  // Push to a SINGLE agent — this is the CANARY step.
  socket.on('admin_push_update_one', (clientId) => {
    if (!requireAdmin(socket)) return;
    const c = clients.get(clientId);
    if (!c || !c.socketId) return socket.emit('admin_error', 'Agent is offline — it will update on next launch');
    const target = feedVersion(c.platform);
    if (!target) return socket.emit('admin_error',
      `No ${normPlatform(c.platform) === 'mac' ? 'mac' : 'Windows'} update is staged (updates/${feedYmlName(c.platform)} missing)`);
    if (activeSessions.has(clientId)) return socket.emit('admin_error', 'Agent is in a live session — try again when idle');
    if (c.version === target) return socket.emit('admin_error', `Agent is already on ${target}`);
    const p = normPlatform(c.platform);
    pushedCanaries.add(clientId);
    io.to(c.socketId).emit('check_update', { allowDowngrade: rollbackMode[p] });
    console.log(`AUDIT push_one by ${supports.get(socket.id).name} -> ${clientId} target ${target} (${p}, rollback=${rollbackMode[p]})`);
    socket.emit('admin_ok', `Update pushed to ${clientId}. Waiting for it to report ${target}…`);
  });

  // Push to ALL online, idle agents — GATED behind a healthy canary PER
  // PLATFORM: a healthy mac canary does not unlock pushing an untested
  // Windows build and vice versa.
  socket.on('admin_push_update_all', () => {
    if (!requireAdmin(socket)) return;
    if (!canaryHealthy.win && !canaryHealthy.mac)
      return socket.emit('admin_error', 'Push a single canary agent first and wait until it reports the new version');
    const targets = { win: feedVersion('win'), mac: feedVersion('mac') };
    let n = 0, skipped = 0;
    const lockedPlatforms = new Set();
    for (const [id, c] of clients) {
      if (!c.socketId) continue;
      if (activeSessions.has(id)) { skipped++; continue; }
      const p = normPlatform(c.platform);
      const target = targets[p];
      if (!target || c.version === target) continue;   // nothing staged, or already current
      if (!canaryHealthy[p]) { lockedPlatforms.add(p); continue; }  // platform not canary-cleared
      io.to(c.socketId).emit('check_update', { allowDowngrade: rollbackMode[p] });
      n++;
    }
    console.log(`AUDIT push_all by ${supports.get(socket.id).name} targets win=${targets.win} mac=${targets.mac} -> ${n} agents (${skipped} in-session skipped, locked=${[...lockedPlatforms].join(',') || 'none'})`);
    let msg = `Update pushed to ${n} agent(s)`;
    if (skipped) msg += `, ${skipped} skipped (in session)`;
    if (lockedPlatforms.size) msg += `. ${[...lockedPlatforms].map(p => p === 'mac' ? 'macOS' : 'Windows').join(' & ')} agents skipped — push a canary on that platform first`;
    socket.emit('admin_ok', msg);
  });

  // Roll back (or roll forward) to any archived version.
  socket.on('admin_activate_version', (version) => {
    if (!requireAdmin(socket)) return;
    const result = activateVersion(String(version || ''));
    if (result.error) return socket.emit('admin_error', result.error);
    console.log(`AUDIT activate_version by ${supports.get(socket.id).name} -> ${result.version} (rollback=${result.rollback})`);
    socket.emit('admin_ok', `Now serving ${result.version}${result.rollback ? ' (rollback — push a canary, then push to all)' : ''}`);
    broadcastClients();
    for (const [sid, s] of supports) if (s.role === 'admin') io.to(sid).emit('admin_feed', feedInfo());
  });

  socket.on('admin_reset_rollout', () => {
    if (!requireAdmin(socket)) return;
    canaryHealthy.win = false; canaryHealthy.mac = false; pushedCanaries.clear();
    socket.emit('admin_ok', 'Rollout reset — a canary is required again');
    socket.emit('admin_feed', feedInfo());
  });

  // ── Delete an agent permanently ──
  // Pending (never-installed) slots: any support user can delete their typo.
  // Real registered agents: admin-only.
  socket.on('remove_client', (clientId) => {
    if (!supports.has(socket.id)) return;
    const entry = getAgent(clientId);
    if (!entry && !clients.has(clientId)) return;
    const isPending = !!(entry && entry.pending);
    if (!canSeeAgent(supports.get(socket.id), clientId)) return;
    if (!isPending && !requireAdmin(socket)) return;
    if (activeSessions.has(clientId)) return;   // never delete an in-session client
    // Drop from persistent registry + live map + disconnect the client socket
    delete agents[clientId];
    persistAgents();
    const cd = clients.get(clientId);
    if (cd && cd.socketId) io.to(cd.socketId).emit('deleted_by_admin');
    clients.delete(clientId);
    for (const [name, p] of reconnectTimers) if (p.clientId === clientId) reconnectTimers.delete(name);
    clientReconnectTimers.delete(clientId);
    console.log(`Agent ${clientId} deleted by ${supports.get(socket.id).name}`);
    broadcastClients();
  });

  socket.on('agent_logout', () => {
    if (!supports.has(socket.id)) return;
    const sup = supports.get(socket.id);
    if (sup.targetClientId && activeSessions.has(sup.targetClientId)) endSession(sup.targetClientId, 'agent_logout');
    supports.delete(socket.id);
    console.log(`Support ${sup.name} logged out`);
    socket.emit('logout_ok');
    broadcastClients();
  });

  socket.on('client_disconnect', () => {
    if (socket.clientId) {
      for (const [name, p] of reconnectTimers) {
        if (p.clientId === socket.clientId) { reconnectTimers.delete(name); break; }
      }
      if (activeSessions.has(socket.clientId)) endSession(socket.clientId, 'client_ended');
    }
  });

  // ── WebRTC relay ──
  socket.on('offer',         (data) => io.to(data.target).emit('offer',         { sender: socket.id, sdp: data.sdp }));
  socket.on('answer',        (data) => io.to(data.target).emit('answer',        { sender: socket.id, sdp: data.sdp }));
  socket.on('ice-candidate', (data) => io.to(data.target).emit('ice-candidate', { sender: socket.id, candidate: data.candidate }));

  socket.on('force_reset_all', () => {
    if (!requireAdmin(socket)) return;
    console.log('Force reset by', socket.id);
    reconnectTimers.clear();
    clientReconnectTimers.clear();
    activeSessions.clear();
    io.emit('server_reset');
    broadcastClients();
  });

  socket.on('disconnect', () => {
    console.log('Disconnected:', socket.id);

    // ── Client disconnected ──
    if (socket.clientId) {
      const current = clients.get(socket.clientId);
      if (current && current.socketId && current.socketId !== socket.id) {
        console.log(`Stale socket ${socket.id} for ${socket.clientId} closed — client already reconnected`);
        return;
      }
      const agentSocketId = activeSessions.get(socket.clientId);
      if (agentSocketId && supports.has(agentSocketId)) {
        clientReconnectTimers.set(socket.clientId, { agentSocketId });
        io.to(agentSocketId).emit('client_reconnecting', { clientId: socket.clientId });
        console.log(`Client ${socket.clientId} went offline — session preserved`);
      } else if (activeSessions.has(socket.clientId)) {
        activeSessions.delete(socket.clientId);
      }
      // Mark offline but KEEP availability (persisted) so it comes back available.
      const clientData = clients.get(socket.clientId);
      if (clientData) clientData.socketId = null;
      broadcastClients();
    }

    // ── Support disconnected ──
    if (supports.has(socket.id)) {
      const sup = supports.get(socket.id);
      supports.delete(socket.id);
      if (sup.targetClientId && clients.has(sup.targetClientId) && activeSessions.has(sup.targetClientId)) {
        const clientId = sup.targetClientId, agentName = sup.name;
        const clientData = clients.get(clientId);
        if (clientData) io.to(clientData.socketId).emit('agent_reconnecting', { agentName });
        reconnectTimers.set(agentName, { clientId });
        console.log(`Support ${agentName} disconnected — session with ${clientId} preserved`);
        broadcastClients();
      } else {
        broadcastClients();
      }
    }
  });
});

// A malformed socket payload (e.g. an `offer` frame with no data) throws
// synchronously inside a socket.io listener; without this the exception is
// uncaught and Node exits, dropping every client and live session. Log and
// stay up instead — one bad peer must not take down the fleet.
process.on('uncaughtException', (e) => console.error('uncaughtException:', e && e.stack || e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e && e.stack || e));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Signaling server running on port ${PORT}`));
