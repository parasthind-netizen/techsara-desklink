const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');
const net = require('net');
const { execFileSync } = require('child_process');

const app = express();
const server = http.createServer(app);
app.disable('x-powered-by');
app.set('env', 'production');   // don't let error bodies depend on NODE_ENV
// No body parser: every Express route is a GET with no body (socket.io handles
// its own traffic under /socket.io/ before Express sees it). Not mounting one
// removes a whole class of unauthenticated error responses.

// ─────────────────────────────────────────────────────────────
// Security headers on every response.
// The console loads no third-party code: scripts, styles and fonts are all
// served from this origin, so the Content-Security-Policy can forbid
// everything else outright ('unsafe-inline' is for style attributes only —
// there is no inline script anywhere).
// ─────────────────────────────────────────────────────────────
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' ws: wss:",
  "media-src 'self' blob: mediastream:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});

// ─────────────────────────────────────────────────────────────
// Persistent stores (flat JSON files, atomic writes). A single
// instance so no DB needed; survives restarts and redeploys.
// ─────────────────────────────────────────────────────────────
const DATA_DIR   = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const AGENTS_FILE= path.join(DATA_DIR, 'agents.json');
const CONFIG_FILE= path.join(DATA_DIR, 'config.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// A data file that is missing (ENOENT) is a genuine first boot → use the empty
// fallback. ANY other failure (permission error, truncated/0-byte file, invalid
// JSON, or a value that is not a plain object) means the real data is there but
// unreadable: refuse to start rather than silently treat it as empty and then
// overwrite it — an empty agents.json would tell the whole fleet to
// de-provision itself. (The live file is left untouched for hand-recovery.)
function loadJSON(file, fallback) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') return fallback;
    console.error(`FATAL: cannot read ${file}: ${e && e.message}. Refusing to start so existing data is not overwritten.`);
    process.exit(1);
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // tolerate a BOM
  let val;
  try { val = JSON.parse(text); }
  catch (e) {
    console.error(`FATAL: ${file} is not valid JSON (${e && e.message}). Refusing to start so existing data is not overwritten.`);
    process.exit(1);
  }
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    console.error(`FATAL: ${file} did not contain a JSON object. Refusing to start.`);
    process.exit(1);
  }
  return val;
}
// Durable write: write a temp file, flush it to disk, keep the last good copy
// as <file>.bak (by copy — never rename the live file away, a crash mid-rename
// would leave nothing), then atomically replace. The directory fsync makes the
// rename itself durable and is best-effort (it throws EPERM on Windows).
function saveJSON(file, obj) {
  const tmp = file + '.tmp';
  const data = JSON.stringify(obj, null, 2);
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak'); } catch (_) {}
  fs.renameSync(tmp, file);
  try {
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } catch (_) {}
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

// Names typed by people (customers, team members, the product name) are shown
// in other people's consoles — strip control characters and angle brackets so
// a name can never carry markup, whatever the client does with it.
function cleanName(v) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Console session tokens ──
// A signed, stateless token lets a signed-in console re-register after a
// socket reconnect or a page reload WITHOUT the password being kept in the
// browser. The signature covers the account's current password hash, so a
// password reset (or deleting the account) invalidates every outstanding
// token at once; suspension is re-checked on every use.
if (!appConfig.sessionSecret) {
  appConfig.sessionSecret = crypto.randomBytes(32).toString('hex');
  persistConfig();
}
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
// Changes every time the server starts — a console that reconnects can tell a
// restart (live sessions were forgotten) from an ordinary network blip.
const BOOT_ID = crypto.randomBytes(8).toString('hex');
function signSession(username, expires, user) {
  // sessionGen bumps on every password sign-in and on Log out, so a token from
  // an earlier sign-in (a sleeping laptop that wakes later, a logged-out tab)
  // stops verifying. Reload / reconnect / resume-after-deploy reuse the current
  // generation via the token and refresh_session, so they keep working.
  return crypto.createHmac('sha256', appConfig.sessionSecret)
    .update(username + '|' + expires + '|' + (user.sessionGen || 0) + '|' + user.passwordHash)
    .digest('base64url');
}
function issueSessionToken(username, user) {
  const expires = Date.now() + SESSION_TTL_MS;
  return 'v1.' + Buffer.from(username).toString('base64url') + '.' + expires + '.' + signSession(username, expires, user);
}
function verifySessionToken(token, username, user) {
  const parts = String(token || '').split('.');
  if (!user || parts.length !== 4 || parts[0] !== 'v1') return false;
  let name;
  try { name = Buffer.from(parts[1], 'base64url').toString('utf8'); } catch (_) { return false; }
  if (name !== username) return false;
  const expires = parseInt(parts[2], 10);
  if (!Number.isFinite(expires) || expires < Date.now()) return false;
  const given = Buffer.from(parts[3]);
  const expected = Buffer.from(signSession(username, expires, user));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// ── Sign-in throttle ──
// Failed password attempts are counted per (viewer, username) and, with a much
// higher ceiling, per username — the second bound still holds if someone hits
// the origin directly with forged forwarding headers.
const LOGIN_WINDOW_MS      = 10 * 60 * 1000;
const LOGIN_MAX_PER_VIEWER = 8;
const LOGIN_MAX_PER_USER   = 100;
const LOGIN_FAIL_MAX_ENTRIES = 50000;
const loginFailures = new Map();   // key -> { count, windowStart }
let lastLoginPrune = 0;

// When set, X-Forwarded-For is trusted only on requests that carry the matching
// secret header (added by CloudFront as a custom origin header). This stops a
// caller that reaches the origin port directly from forging the viewer address
// to spend another user's attempt budget. Unset → best-effort: trust a
// well-formed XFF hop. Either way the key is bounded so it can't exhaust memory.
const TRUSTED_ORIGIN_SECRET = process.env.TRUSTED_ORIGIN_SECRET || '';
// The viewer's address from a request's headers: the last X-Forwarded-For hop
// (validated as an IP and length-bounded so it can never exhaust a Map), but
// only when the request is trusted — unset secret means best-effort, a set
// secret means the hop is believed only on requests CloudFront marked. A
// forged header on a direct origin hit falls back to the real peer address.
function trustedViewer(headers, fallbackAddr) {
  const h = headers || {};
  const trusted = !TRUSTED_ORIGIN_SECRET || h['x-origin-secret'] === TRUSTED_ORIGIN_SECRET;
  if (trusted) {
    const hops = String(h['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    const hop = hops.length ? hops[hops.length - 1] : '';
    if (hop && hop.length <= 45 && net.isIP(hop)) return hop;
  }
  return String(fallbackAddr || '?');
}
function loginViewer(socket) {
  return trustedViewer(socket.handshake.headers, socket.handshake.address);
}
function loginFailCount(key) {
  const f = loginFailures.get(key);
  if (!f) return 0;
  if (Date.now() - f.windowStart > LOGIN_WINDOW_MS) { loginFailures.delete(key); return 0; }
  return f.count;
}
function pruneLoginFailures() {
  const now = Date.now();
  if (now - lastLoginPrune < 5000) return;   // at most once every few seconds
  lastLoginPrune = now;
  for (const [k, v] of loginFailures) if (now - v.windowStart > LOGIN_WINDOW_MS) loginFailures.delete(k);
  if (loginFailures.size > LOGIN_FAIL_MAX_ENTRIES) {
    // Over the hard ceiling: shed the most-stale per-VIEWER counters only, so a
    // real account's per-user counter (prefix "user|") is never flushed by a
    // flood of junk-name attempts.
    for (const k of loginFailures.keys()) {
      if (loginFailures.size <= LOGIN_FAIL_MAX_ENTRIES) break;
      if (k.lastIndexOf('user|', 0) !== 0) loginFailures.delete(k);
    }
  }
}
function noteLoginFailure(key) {
  pruneLoginFailures();
  const now = Date.now();
  let f = loginFailures.get(key);
  if (!f || now - f.windowStart > LOGIN_WINDOW_MS) f = { count: 0, windowStart: now };
  f.count++;
  loginFailures.set(key, f);
}

// ── Installation-code bind throttle ──
// A separate counter (slot names can equal usernames) that limits wrong
// installation codes on `register` so a pending slot's 9-digit code cannot be
// brute-forced. A real install sends the right code once, so these caps never
// bite it. A pending code also expires, bounding the guessing window.
const bindFailures = new Map();    // key -> { count, windowStart }
const BIND_MAX_PER_VIEWER = 8;
const BIND_MAX_PER_SLOT   = 60;
const PENDING_CODE_TTL_MS  = 7 * 24 * 60 * 60 * 1000;
const REGISTER_REJECT_MSG  = 'This computer could not be set up. Ask your support agent for a current installation code.';
function bindFailCount(key) {
  const f = bindFailures.get(key);
  if (!f) return 0;
  if (Date.now() - f.windowStart > LOGIN_WINDOW_MS) { bindFailures.delete(key); return 0; }
  return f.count;
}
function noteBindFailure(key) {
  const now = Date.now();
  if (bindFailures.size > LOGIN_FAIL_MAX_ENTRIES) {
    for (const [k, v] of bindFailures) if (now - v.windowStart > LOGIN_WINDOW_MS) bindFailures.delete(k);
  }
  let f = bindFailures.get(key);
  if (!f || now - f.windowStart > LOGIN_WINDOW_MS) f = { count: 0, windowStart: now };
  f.count++;
  bindFailures.set(key, f);
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
  // users.json exists with accounts but no admin: do NOT mint a default
  // admin/admin123 over a real install. Only seed from an explicit password.
  if (Object.keys(users).length > 0 && !process.env.ADMIN_PASSWORD) {
    console.warn('No admin account found and ADMIN_PASSWORD not set — not seeding a default admin on an existing install.');
    return;
  }
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
  const rec = { passwordHash: hash, salt, role, suspended: false, createdAt: Date.now(), createdBy };
  // A support account is a full tenant owner (its own Customer ID + org), so it
  // shows up in the Owner Console and sees its own machines at once instead of
  // being a half-provisioned account that only resolves after a restart. Admin
  // accounts stay tenant-less.
  if (role === 'support') {
    const customerId = nextCustomerId();
    rec.customerId = customerId;
    rec.displayName = username;
    rec.tenantId = customerId;
    rec.isTenantOwner = true;
    rec.teamLimit = 5;
  }
  users[username] = rec;
  persistUsers();
  return { ok: true };
}

// ── Customers (tenants) ──
// A "customer" is a support-role account with a stable Customer ID (TS-####)
// and a display name. Its agents are already isolated from other customers by
// the per-owner filtering (a customer only ever sees agents it owns). The
// product owner (admin) creates customers, suspends/enables them, and resets
// their passwords from the Owner Console.
// Customer IDs are never reused: the highest number ever issued is remembered,
// so deleting the newest customer does not hand its ID to the next one.
function nextCustomerId() {
  let max = parseInt(appConfig.customerSeq, 10) || 0;
  for (const u of Object.values(users)) {
    const m = /^TS-(\d+)$/.exec(String(u && u.customerId || ''));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  appConfig.customerSeq = max + 1;
  persistConfig();
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
  displayName = cleanName(displayName);
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
  displayName = cleanName(displayName);
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
  for (const name of Object.keys(agents))
    if (agentTenantId(name) === tenantId) n++;
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
    // Team members belong to their organization's tenant and have no Customer
    // ID of their own. Never mint one for them — that would burn a customer
    // number on every boot. Only give them the display-name / suspended default.
    if (u.tenantId && u.isTenantOwner === false) {
      if (!u.displayName) { u.displayName = username; changed++; }
      if (u.suspended === undefined) { u.suspended = false; changed++; }
      continue;
    }
    if (!u.customerId) { u.customerId = nextCustomerId(); changed++; }
    if (!u.displayName) { u.displayName = username; changed++; }
    if (u.suspended === undefined) { u.suspended = false; changed++; }
    // Pre-team accounts each become the owner of their own tenant.
    if (!u.tenantId) { u.tenantId = u.customerId; changed++; }
    if (u.isTenantOwner === undefined) u.isTenantOwner = true;
    if (u.teamLimit === undefined) { u.teamLimit = 5; changed++; }
  }
  if (changed) { persistUsers(); console.log(`Customer migration: updated ${changed} account field(s)`); }
})();

// Fix the customer-ID high-water mark at boot = the highest TS number ever
// issued, so the "never reused" guarantee holds even if the newest customer is
// deleted before the next one is created (nextCustomerId would otherwise fall
// back to the max among surviving accounts and re-hand that ID).
(function initCustomerSeq() {
  const current = parseInt(appConfig.customerSeq, 10) || 0;
  let max = current;
  for (const u of Object.values(users)) {
    const m = /^TS-(\d+)$/.exec(String(u && u.customerId || ''));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  if (max !== current) { appConfig.customerSeq = max; persistConfig(); }
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
const reconnectTimers = new Map();      // agentName -> { clientId, timer }   (support side dropped mid-session)
const clientReconnectTimers = new Map();// clientId -> { agentSocketId, timer } (machine dropped mid-session)

// A session whose console or machine drops is HELD so that a reload, a network
// blip or a reboot resumes it — but only for a grace period. Without the limit
// a machine would stay "in session" for the whole team until that one person
// signed in again.
const SUPPORT_GRACE_MS = Math.max(1000, parseInt(process.env.SUPPORT_GRACE_MS, 10) || 2 * 60 * 1000);
const CLIENT_GRACE_MS  = Math.max(1000, parseInt(process.env.CLIENT_GRACE_MS, 10)  || 10 * 60 * 1000);  // covers a reboot

// A machine whose session ended while it was offline must be told to stop
// capturing (and drop the "is viewing your screen" banner) the moment it
// returns. We remember such machines and notify them on their next register.
const strandedMachines = new Set();        // clientIds whose session ended while away
// The installed client repaints to "Active" ~2.5s after a session_ended (an
// uncancelled timer). So a support_request must not be sent to a machine within
// that window of a session_ended, or the banner would vanish mid-share. Pace
// every support_request past it.
const lastSessionEndedAt = new Map();      // clientId -> when we last sent session_ended to it
const SUPPORT_REQUEST_GAP_MS = Math.max(0, parseInt(process.env.SUPPORT_REQUEST_GAP_MS, 10) || 3500);
function markSessionEndedSent(clientId) { lastSessionEndedAt.set(clientId, Date.now()); }
// Emit support_request to a machine, but never inside the post-session_ended
// window, and only while the session still stands for the same console.
function sendSupportRequest(clientId, payload) {
  const emit = () => {
    const cd = clients.get(clientId);
    if (!cd || !cd.socketId) return;
    if (activeSessions.get(clientId) !== payload.supportId || !supports.has(payload.supportId)) return;
    io.to(cd.socketId).emit('support_request', payload);
  };
  const wait = SUPPORT_REQUEST_GAP_MS - (Date.now() - (lastSessionEndedAt.get(clientId) || 0));
  if (wait > 0) setTimeout(emit, wait); else emit();
}

function dropSupportHold(agentName) {
  const held = reconnectTimers.get(agentName);
  if (held && held.timer) clearTimeout(held.timer);
  reconnectTimers.delete(agentName);
}
function dropClientHold(clientId) {
  const held = clientReconnectTimers.get(clientId);
  if (held && held.timer) clearTimeout(held.timer);
  clientReconnectTimers.delete(clientId);
}
// Forget every hold that points at this machine (its session is over, or
// someone else has taken it).
function dropHoldsForClient(clientId) {
  for (const [name, p] of reconnectTimers) if (p.clientId === clientId) dropSupportHold(name);
  dropClientHold(clientId);
}
function holdSupportSession(agentName, clientId) {
  dropSupportHold(agentName);
  const hold = { clientId, timer: null };
  hold.timer = setTimeout(() => {
    if (reconnectTimers.get(agentName) !== hold) return;
    reconnectTimers.delete(agentName);
    const sid = activeSessions.get(clientId);
    if (sid && supports.has(sid)) return;            // a live console holds it now
    console.log(`Held session ${agentName} -> ${clientId} expired — machine released`);
    endSession(clientId, 'agent_timeout');
  }, SUPPORT_GRACE_MS);
  if (hold.timer.unref) hold.timer.unref();
  reconnectTimers.set(agentName, hold);
}
function holdClientSession(clientId, agentSocketId) {
  dropClientHold(clientId);
  const hold = { agentSocketId, timer: null };
  hold.timer = setTimeout(() => {
    if (clientReconnectTimers.get(clientId) !== hold) return;
    clientReconnectTimers.delete(clientId);
    const c = clients.get(clientId);
    if (c && c.socketId) return;                     // it came back
    console.log(`Machine ${clientId} did not return — held session released`);
    endSession(clientId, 'client_timeout');
  }, CLIENT_GRACE_MS);
  if (hold.timer.unref) hold.timer.unref();
  clientReconnectTimers.set(clientId, hold);
}

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

// ── Static assets: gzip + validators, no extra dependencies ──
// Files are read once and kept (raw + gzipped) until their mtime changes, so a
// deploy is picked up without a restart. HTML/CSS/JS always revalidate (cheap
// 304s) so a release is live on the next page load; fonts never change under
// the same name, so browsers may keep them for a year.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.txt':  'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png':  'image/png',
  '.ico':  'image/x-icon'
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.svg', '.txt']);
const assetCache = new Map();   // absolute path -> { mtimeMs, size, ext, raw, gz, etag }

function loadAsset(absPath) {
  let st;
  try { st = fs.statSync(absPath); } catch (_) { return null; }
  if (!st.isFile()) return null;
  const hit = assetCache.get(absPath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  const raw = fs.readFileSync(absPath);
  const ext = path.extname(absPath).toLowerCase();
  const entry = {
    mtimeMs: st.mtimeMs, size: st.size, ext, raw,
    gz: (COMPRESSIBLE.has(ext) && raw.length > 1024) ? zlib.gzipSync(raw, { level: 9 }) : null,
    etag: 'W/"' + st.size.toString(16) + '-' + Math.round(st.mtimeMs).toString(16) + '"'
  };
  assetCache.set(absPath, entry);
  return entry;
}

// Returns false when there is no such file (the caller falls through).
function sendAsset(req, res, absPath) {
  const a = loadAsset(absPath);
  if (!a) return false;
  res.setHeader('Content-Type', MIME[a.ext] || 'application/octet-stream');
  res.setHeader('ETag', a.etag);
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('Cache-Control', a.ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache');
  const inm = String(req.headers['if-none-match'] || '');
  if (inm && inm.split(',').map(s => s.trim()).includes(a.etag)) { res.statusCode = 304; res.end(); return true; }
  const gzip = !!a.gz && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  const body = gzip ? a.gz : a.raw;
  if (gzip) res.setHeader('Content-Encoding', 'gzip');
  res.setHeader('Content-Length', body.length);
  res.statusCode = 200;
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

// Fall through to the 404 handler if the file is briefly missing (e.g. mid
// deploy swap) instead of leaving the request hanging until the CDN times out.
app.get('/', (req, res, next) => { if (!sendAsset(req, res, path.join(DASHBOARD_DIR, 'landing.html'))) next(); });
app.get(['/dashboard', '/dashboard/', '/app'], (req, res, next) => { if (!sendAsset(req, res, path.join(DASHBOARD_DIR, 'index.html'))) next(); });
app.get('/favicon.ico', (req, res, next) => { if (!sendAsset(req, res, path.join(DASHBOARD_DIR, 'favicon.svg'))) next(); });

// Everything else under dashboard/ (scripts, styles, fonts, download page).
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  let rel;
  try { rel = decodeURIComponent(req.path); } catch (_) { return next(); }
  if (rel.includes('\0') || rel.split('/').some(seg => seg.startsWith('.'))) return next();
  const abs = path.normalize(path.join(DASHBOARD_DIR, rel));
  if (!abs.startsWith(DASHBOARD_DIR + path.sep)) return next();   // never outside dashboard/
  if (!sendAsset(req, res, abs)) next();
});

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
const redeemByViewer = new Map();  // viewer -> { count, windowStart }  (per real caller)
const redeemByPeer   = new Map();  // peer   -> { count, windowStart }  (bounds forged headers)
function bumpBucket(map, key, now) {
  if (map.size > 5000) for (const [k, v] of map) if (now - v.windowStart > 10 * 60 * 1000) map.delete(k);
  let a = map.get(key);
  if (!a || now - a.windowStart > 10 * 60 * 1000) a = { count: 0, windowStart: now };
  a.count++; map.set(key, a); return a.count;
}
app.get('/api/redeem-code', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  // Behind CloudFront every request arrives from a CloudFront address, so a
  // single peer bucket would let one guesser lock out every customer behind the
  // same node. Throttle per real caller (validated last XFF hop) at 60/10min,
  // and keep a much higher ceiling per peer so a forged header on a direct
  // origin hit still stays bounded.
  const ip = req.socket.remoteAddress || '?';
  const viewer = trustedViewer(req.headers, ip);
  const now = Date.now();
  const perViewer = bumpBucket(redeemByViewer, viewer, now);
  const perPeer   = bumpBucket(redeemByPeer, ip, now);
  if (perViewer > 60 || perPeer > 600) return res.status(429).json({ error: 'Too many attempts — wait a few minutes and try again' });

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

// Which installers this server can actually hand out. The public pages read it
// so they never offer a download that is not there yet (e.g. the Mac build
// before its first release is staged).
app.get('/api/downloads', (req, res) => {
  const has = (name) => {
    try { return fs.statSync(path.join(__dirname, 'downloads', name)).isFile(); } catch (_) { return false; }
  };
  const arm = has(DL_DMG), intel = has(DL_DMG_INTEL);
  res.set('Cache-Control', 'no-store');
  res.json({
    windows: { available: has(DL_EXE) || has('TechsaraSupport-Setup.exe'), version: feedVersion('win') },
    mac: { available: arm || intel, appleSilicon: arm, intel, version: (arm || intel) ? feedVersion('mac') : null }
  });
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

// Nothing matched: a plain 404, no path echo.
app.use((req, res) => { res.status(404).type('text/plain').send('Not found'); });
// Last-resort error handler: status text only, never a stack or file path in
// the body; the stack is logged server-side for 5xx only.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  let status = err && (err.status || err.statusCode);
  if (!(status >= 400 && status <= 599)) status = 500;
  if (status >= 500) console.error('HTTP error:', err && err.stack || err);
  for (const h of ['Content-Disposition', 'ETag', 'Last-Modified', 'Cache-Control', 'Accept-Ranges', 'Content-Encoding']) res.removeHeader(h);
  res.status(status).type('text/plain').send(http.STATUS_CODES[status] || 'Error');
});

const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

// ── Helpers ──
// Who a machine is in a session with: the live console, or the person whose
// dropped console is still inside its grace period. null = the machine is free
// (a leftover activeSessions entry with neither is not a session).
function getSessionAgentName(clientId) {
  const sid = activeSessions.get(clientId);
  if (sid && supports.has(sid)) return supports.get(sid).name;
  for (const [name, p] of reconnectTimers) if (p.clientId === clientId) return name;
  return null;
}
function inSession(clientId) {
  return activeSessions.has(clientId) && !!getSessionAgentName(clientId);
}

function endSession(clientId, reason) {
  const supportSocketId = activeSessions.get(clientId);
  activeSessions.delete(clientId);
  dropHoldsForClient(clientId);   // an ended session must never be "restored" later

  // NOTE: availability is persistent now — a session ending does NOT make the
  // agent unavailable. It stays available until the client disables it or an
  // admin deletes it. (Requested: unattended, always-on support desks.)
  if (supportSocketId && supports.has(supportSocketId)) {
    const sup = supports.get(supportSocketId);
    if (sup) sup.targetClientId = null;
    io.to(supportSocketId).emit('session_ended', { clientId, reason });
  }
  const clientData = clients.get(clientId);
  if (clientData && clientData.socketId) {
    io.to(clientData.socketId).emit('session_ended', { reason });
    markSessionEndedSent(clientId);   // pace any follow-up support_request past the client's repaint timer
  } else if (clientData) {
    // The machine is offline: it can't be told now, so it keeps capturing and
    // showing the banner. Notify it the moment it re-registers.
    strandedMachines.add(clientId);
  }

  console.log(`Session ended: ${clientId} — reason: ${reason}`);
  broadcastClients();
}

// Authorize and forward one WebRTC signalling frame. A frame is relayed only
// when the sender is a current party to a live session and `target` is the
// other party's socket, so no socket can inject an offer/answer/candidate into
// a session it is not in (or, with a non-string `target`, into every session).
const MAX_SDP = 256 * 1024;      // an SDP blob is a few KB; this is generous
const MAX_CANDIDATE = 8 * 1024;  // one ICE candidate
function relayPeer(socket, kind, data) {
  if (!data || typeof data.target !== 'string' || !data.target) return;
  const target = data.target;

  const asClient = socket.clientId ? clients.get(socket.clientId) : null;
  const isLiveClient = asClient && asClient.socketId === socket.id;
  const sup = supports.get(socket.id);

  if (isLiveClient) {
    if (kind === 'answer') return;                                // a machine never answers
    if (activeSessions.get(socket.clientId) !== target) {
      // A machine offering with NO standing session is stale (it came back and
      // kept sharing): tell it to tear down. Stay silent if a session stands
      // with a different console socket (a mid-handoff race), so a live session
      // is never torn down.
      if (kind === 'offer' && !activeSessions.has(socket.clientId)) {
        io.to(socket.id).emit('session_ended', { reason: 'not_in_session' });
        markSessionEndedSent(socket.clientId);
      }
      return;
    }
  } else if (sup) {
    if (kind === 'offer') return;                                 // a console never offers
    const cid = sup.targetClientId;
    if (!cid || activeSessions.get(cid) !== socket.id) return;    // it must hold that session
    const cd = clients.get(cid);
    if (!cd || cd.socketId !== target) return;                    // only toward that machine's socket
  } else {
    return;                                                       // not a party to any session
  }

  if (kind === 'ice-candidate') {
    const c = data.candidate;
    if (!c || typeof c !== 'object' || JSON.stringify(c).length > MAX_CANDIDATE) return;
    io.to(target).emit('ice-candidate', { sender: socket.id, candidate: c });
  } else {
    const d = data.sdp;
    if (!d || typeof d.sdp !== 'string' || d.sdp.length > MAX_SDP) return;
    io.to(target).emit(kind, { sender: socket.id, sdp: { type: d.type, sdp: d.sdp } });
  }
}

// Sign a person's console(s) out right now (password reset, suspension,
// removal): end what they were doing, tell the console why, and forget any
// session that was being held for their return.
function signOutUser(username, message, reason) {
  for (const [sid, s] of Array.from(supports.entries())) {
    if (s.name !== username) continue;
    supports.delete(sid);
    if (s.targetClientId && activeSessions.get(s.targetClientId) === sid) endSession(s.targetClientId, reason);
    io.to(sid).emit('force_logout', message);
  }
  const held = reconnectTimers.get(username);
  if (held) {
    dropSupportHold(username);
    if (activeSessions.has(held.clientId) && !getSessionAgentName(held.clientId)) endSession(held.clientId, reason);
  }
}

// Every machine the server knows about, with its live state.
function buildClientList() {
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
      isBusy: inSession(id),
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
  return clientList;
}

// Agents are private to their TENANT -- every team member of a customer is
// sent that customer's machines; admins (product owner) get the whole fleet.
function clientListFor(sup, all) {
  return sup.role === 'admin' ? all : all.filter(c => c.tenantId && c.tenantId === sup.tenantId);
}

function broadcastClients() {
  const all = buildClientList();
  for (const [socketId, sup] of supports) io.to(socketId).emit('clients_list', clientListFor(sup, all));
}

function requireAdmin(socket) {
  const sup = supports.get(socket.id);
  return sup && sup.role === 'admin';
}

// ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  socket.on('register', (data) => {
    if (!data || typeof data !== 'object') return;
    // ── CLIENT (the machine being supported) ──
    if (data.type === 'client') {
      if (supports.has(socket.id)) return;   // a console socket cannot also be a machine
      const clientId = String(data.clientId || '').trim();
      // Only machines the support team created (via installation code) — or
      // that were already registered before this gate existed — may register.
      const persisted = getAgent(clientId);
      if (!clientId || !persisted) {
        console.warn(`Register REJECTED for unknown agent "${clientId}"`);
        socket.emit('register_rejected', REGISTER_REJECT_MSG);
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
        // A stale pending code is treated as expired rather than left guessable.
        if (persisted.createdAt && Date.now() - persisted.createdAt > PENDING_CODE_TTL_MS) {
          console.warn(`Register REJECTED for pending "${clientId}" — install code expired`);
          return socket.emit('register_rejected', REGISTER_REJECT_MSG);
        }
        // Throttle wrong codes: per-viewer (fast) and per-slot (the bound that
        // holds even if the viewer address is forged). Checked before the code
        // is compared; once a slot is locked nothing more is recorded for it.
        const bviewer = loginViewer(socket);
        const vKey = 'bindv|' + bviewer + '|' + clientId;
        const sKey = 'binds|' + clientId;
        if (bindFailCount(sKey) >= BIND_MAX_PER_SLOT || bindFailCount(vKey) >= BIND_MAX_PER_VIEWER) {
          console.warn(`Register THROTTLED for pending "${clientId}" (from ${bviewer})`);
          return socket.emit('register_rejected', REGISTER_REJECT_MSG);
        }
        if (givenCode !== String(persisted.installCode || '')) {
          noteBindFailure(vKey);
          noteBindFailure(sKey);
          console.warn(`Register REJECTED for pending "${clientId}" — bad/absent install code (from ${bviewer})`);
          return socket.emit('register_rejected', REGISTER_REJECT_MSG);
        }
      } else if (persisted.secret) {
        // Real agent that already has a per-machine secret: require it. Guards
        // against a stranger re-registering under a known agent name. (A secret
        // only exists once a 1.3.0+ client has connected, so 1.2.0 clients that
        // never had one are never locked out — see issuance below.)
        if (givenSecret !== persisted.secret) {
          console.warn(`Register REJECTED for "${clientId}" — secret mismatch (v=${appVersion})`);
          socket.emit('register_rejected', REGISTER_REJECT_MSG);
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
      // This socket previously registered as a different machine: mark that one
      // offline before adopting the new identity, so it isn't left "online".
      if (socket.clientId && socket.clientId !== clientId) {
        const prevCd = clients.get(socket.clientId);
        if (prevCd && prevCd.socketId === socket.id) prevCd.socketId = null;
      }
      clients.set(clientId, { socketId: socket.id, available, version: appVersion, platform });
      socket.clientId = clientId;
      agents[clientId] = {
        available, version: appVersion, secret, platform,
        owner: persisted.owner || '',
        // The customer this machine belongs to. It must survive every
        // re-register: the owner account can be removed later (a team member
        // leaving) and the machine still has to stay with its organization.
        tenantId: String(persisted.tenantId || userTenantId(persisted.owner) || persisted.owner || ''),
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
      if (!wasPending && pushedCanaries.has(clientId) && appVersion !== 'unknown' && appVersion === feedVersion(platform)) {
        pushedCanaries.delete(clientId);
        canaryHealthy[platform] = true;
        for (const [sid, s] of supports) if (s.role === 'admin')
          io.to(sid).emit('canary_healthy', { clientId, version: appVersion, platform });
        console.log(`Canary ${clientId} healthy on ${appVersion} (${platform}) — push-to-all unlocked for ${platform}`);
      }

      // The machine is back. If it was mid-session and that session still
      // stands (it was not ended or timed out while the machine was away),
      // restart the stream with whoever holds it now.
      const wasHeld = clientReconnectTimers.has(clientId);
      dropClientHold(clientId);
      const agentSocketId = activeSessions.get(clientId);
      if (agentSocketId && supports.has(agentSocketId)) {
        const sup = supports.get(agentSocketId);
        strandedMachines.delete(clientId);
        sendSupportRequest(clientId, { supportId: agentSocketId, agentName: sup.name, restored: true });
        io.to(agentSocketId).emit('client_reconnected', { clientId });
        console.log(`Client ${clientId} ${wasHeld ? 'reconnected' : 're-registered mid-session'} — session with ${sup.name} restored`);
      } else {
        if (agentSocketId && !getSessionAgentName(clientId)) activeSessions.delete(clientId);
        // No session stands for this machine. If one ended while it was away it
        // is still capturing and showing the banner — tell it to stop. Only for
        // clients that have the handler and persistent availability (>=1.3.0),
        // never a fresh install (pending) or a disabled machine (which already
        // cleans up via availability_state).
        if (strandedMachines.delete(clientId) && !wasPending && available && cmpVersion(appVersion, '1.3.0') >= 0) {
          socket.emit('session_ended', { reason: 'not_in_session' });
          markSessionEndedSent(clientId);
        }
      }
      broadcastClients();
      return;
    }

    // ── SUPPORT / ADMIN (dashboard user) ──
    if (data.type === 'support') {
      if (socket.clientId) return;   // a machine socket cannot also be a console
      const username = String(data.username || data.name || '').trim().toLowerCase();
      // Reject anything that could never be an account BEFORE any lookup,
      // bookkeeping or logging — so an oversized or control-laden "username"
      // cannot pin memory in loginFailures or forge log lines.
      if (username.length > 64 || /[\u0000-\u001f\u007f]/.test(username)) {
        return socket.emit('login_error', 'Invalid username or password');
      }
      const password = String(data.password || '');
      const token    = String(data.token || '');
      const user = getUser(username);

      if (token) {
        // Silent re-login of an already signed-in console (reconnect / reload).
        if (!verifySessionToken(token, username, user)) {
          console.warn(`Session token REJECTED for "${username}"`);
          return socket.emit('login_error', 'Your session has expired. Please sign in again.');
        }
      } else {
        const viewer  = loginViewer(socket);
        const pairKey = viewer + '|' + username;
        const userKey = 'user|' + username;
        // Per-viewer is a hard block: one source cannot keep guessing. The
        // per-account ceiling (across all sources) only ever refuses a WRONG
        // password — a CORRECT password from the real user is always accepted
        // below, so the throttle can never be turned into an account lockout.
        if (loginFailCount(pairKey) >= LOGIN_MAX_PER_VIEWER) {
          console.warn(`Login THROTTLED for "${username}" (from ${viewer})`);
          return socket.emit('login_error', 'Too many failed attempts. Please wait a few minutes and try again.');
        }
        // Accept the password verbatim OR trimmed — accounts created before
        // trimming may have stored edge whitespace, and typed ones may carry it.
        const ok = user && (verifyPassword(password, user.salt, user.passwordHash) ||
                            (password !== password.trim() && verifyPassword(password.trim(), user.salt, user.passwordHash)));
        if (!ok) {
          noteLoginFailure(pairKey);
          if (user) noteLoginFailure(userKey);   // per-account key only for real accounts (bounded)
          console.warn(`Login FAILED for "${username}" — ${user ? 'wrong password' : 'no such user'} (from ${viewer})`);
          // Cross-source guessing (many IPs / forged X-Forwarded-For, each under
          // the per-viewer cap): once the per-account ceiling is passed, refuse
          // further WRONG passwords for this account. The correct-password path
          // below is NOT gated, so the real user is never locked out — this only
          // closes the "hit the origin directly with forged headers" angle the
          // per-viewer cap can't. (Real protection is the per-viewer cap +
          // high-entropy generated passwords + TRUSTED_ORIGIN_SECRET.)
          if (user && loginFailCount(userKey) >= LOGIN_MAX_PER_USER) {
            console.warn(`Login ACCOUNT-THROTTLED for "${username}" (cross-source)`);
            return socket.emit('login_error', 'Too many failed attempts. Please wait a few minutes and try again.');
          }
          return socket.emit('login_error', 'Invalid username or password');
        }
        // Correct password: clear this viewer's failures and let them in even if
        // the account's cross-source ceiling was reached.
        loginFailures.delete(pairKey);
        // Start a new session generation so tokens from any earlier sign-in of
        // this account (including one whose socket was asleep) stop verifying.
        user.sessionGen = (user.sessionGen || 0) + 1;
        persistUsers();
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
        tenantId, isTenantOwner,
        token: issueSessionToken(agentName, user),  // for silent re-login; never the password
        boot: BOOT_ID
      };
      const sessionBase = { name: agentName, role, tenantId, isTenantOwner };

      // This socket was signed in as someone else: that console is over.
      const prev = supports.get(socket.id);
      if (prev && prev.name !== agentName) {
        if (prev.targetClientId && activeSessions.get(prev.targetClientId) === socket.id)
          endSession(prev.targetClientId, 'agent_logout');
        supports.delete(socket.id);
      }
      // Same socket registering again under the same login keeps what it has.
      const ownLive = (prev && prev.name === agentName && prev.targetClientId &&
                       activeSessions.get(prev.targetClientId) === socket.id) ? prev.targetClientId : null;
      let resumeId = ownLive;

      // One console per login. An older registration under this login is either
      // this same console back on a new socket before the server saw the old
      // one die (token re-register → its live session moves across), or a
      // second sign-in somewhere else (password → the older console is signed
      // out, and told so instead of being left looking connected).
      for (const [sid, old] of Array.from(supports.entries())) {
        if (old.name !== agentName || sid === socket.id) continue;
        supports.delete(sid);
        const cid = old.targetClientId;
        if (cid && activeSessions.get(cid) === sid) {
          if (token && !resumeId) resumeId = cid;
          else endSession(cid, 'signed_in_elsewhere');
        }
        io.to(sid).emit('force_logout', 'You signed in on another window or device, so this one was signed out.');
      }

      // A session held for this person while their console was away.
      const held = reconnectTimers.get(agentName);
      if (held) {
        dropSupportHold(agentName);
        const holder = activeSessions.get(held.clientId);
        const stillTheirs = activeSessions.has(held.clientId) && !(holder && supports.has(holder));
        if (stillTheirs && !resumeId) resumeId = held.clientId;
        else if (stillTheirs && held.clientId !== resumeId) endSession(held.clientId, 'agent_ended');
      }
      // Never resume into a machine that is gone or no longer theirs to see.
      if (resumeId && resumeId !== ownLive && !(clients.has(resumeId) && canSeeAgent(sessionBase, resumeId))) {
        endSession(resumeId, 'agent_ended');
        resumeId = null;
      }

      // Tells the console which session (if any) the server has for it, so it
      // can re-request one the server lost (e.g. across a server restart).
      loginInfo.session = resumeId || null;

      if (resumeId && resumeId !== ownLive) {
        supports.set(socket.id, { ...sessionBase, targetClientId: resumeId });
        activeSessions.set(resumeId, socket.id);
        socket.emit('login_success', loginInfo);
        socket.emit('session_restored', { clientId: resumeId });
        const clientData = clients.get(resumeId);
        if (clientData && clientData.socketId) {
          strandedMachines.delete(resumeId);
          sendSupportRequest(resumeId, { supportId: socket.id, agentName });
        } else {
          // The machine is away too: wait for it, but not forever.
          const machineHold = clientReconnectTimers.get(resumeId);
          if (machineHold) machineHold.agentSocketId = socket.id;
          else holdClientSession(resumeId, socket.id);
        }
        console.log(`Support ${agentName} reconnected — session with ${resumeId} restored`);
        broadcastClients();
        return;
      }

      supports.set(socket.id, { ...sessionBase, targetClientId: resumeId });
      console.log(`Support registered: ${agentName} (${role}${isTenantOwner ? ', tenant owner' : ''}, tenant ${tenantId})`);
      socket.emit('login_success', loginInfo);
      broadcastClients();
      return;
    }
  });

  // The console's Refresh button: this user's machines, straight from the server.
  socket.on('list_clients', () => {
    const sup = supports.get(socket.id);
    if (sup) socket.emit('clients_list', clientListFor(sup, buildClientList()));
  });

  // A console that stays open for days keeps its sign-in fresh, so a network
  // blip on day two does not bounce the user to the sign-in page.
  socket.on('refresh_session', () => {
    const sup = supports.get(socket.id);
    const user = sup && getUser(sup.name);
    if (!user || user.suspended) return;
    socket.emit('session_token', { token: issueSessionToken(sup.name, user) });
  });

  // ── Client availability (in-app Enable/Disable toggle) — persisted ──
  socket.on('set_availability', (data) => {
    const clientData = clients.get(socket.clientId);
    if (!clientData || clientData.socketId !== socket.id) return;   // only the machine's current socket
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
    // Ownership first, so a non-owner can't read a machine's install state.
    if (!canSeeAgent(sup, clientId)) return socket.emit('agent_availability_error', 'That agent is not yours');
    if (entry.pending) return socket.emit('agent_availability_error', 'This agent has not completed installation yet');
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
    // Seats used vs. the limit the product owner set for this organization.
    const ownerEntry = tenantMembers(sup.tenantId).find(([, u]) => u.isTenantOwner);
    const limit = normTeamLimit(ownerEntry && ownerEntry[1].teamLimit !== undefined ? ownerEntry[1].teamLimit : 5);
    socket.emit('team_quota', { used: members.filter(m => !m.isTenantOwner).length, limit });
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
    if (!u || u.role === 'admin' || String(u.tenantId || '') !== sup.tenantId || u.isTenantOwner)
      return socket.emit('team_error', 'That team member is not in your organization');
    const newPassword = genPassword();
    const { salt, hash } = hashPassword(newPassword);
    u.salt = salt; u.passwordHash = hash; persistUsers();
    signOutUser(uname, 'Your password was reset. Please log in again with the new password.', 'password_reset');
    console.log(`AUDIT team_reset_password ${uname} by ${sup.name}`);
    socket.emit('team_password_reset', { username: uname, displayName: u.displayName || uname, password: newPassword });
    sendTeam(socket, sup);
  });

  socket.on('team_remove', (data) => {
    const sup = supports.get(socket.id);
    if (!sup || sup.role === 'admin' || !sup.isTenantOwner) return socket.emit('team_error', 'Not allowed');
    const uname = String((data && data.username) || '').toLowerCase();
    const u = getUser(uname);
    if (!u || u.role === 'admin' || String(u.tenantId || '') !== sup.tenantId || u.isTenantOwner || uname === sup.name)
      return socket.emit('team_error', 'That team member is not in your organization');
    // Machines this member set up belong to the organization, not to the
    // person: hand them to the organization's owner before the account goes.
    let kept = 0;
    for (const entry of Object.values(agents)) {
      if (!entry || String(entry.owner || '') !== uname) continue;
      entry.owner = sup.name; entry.tenantId = sup.tenantId; kept++;
    }
    if (kept) persistAgents();
    delete users[uname]; persistUsers();
    signOutUser(uname, 'Your access was removed by your organization.', 'team_member_removed');
    if (kept) broadcastClients();
    console.log(`AUDIT team_remove ${uname} by ${sup.name}${kept ? ` (${kept} agent(s) kept with ${sup.tenantId})` : ''}`);
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
    if (!clientData.socketId) {
      // The requester already holds this machine's session and is waiting out
      // its grace period (it dropped, hold running): tell the truth instead of
      // "offline", so the console keeps the session instead of discarding it.
      if (activeSessions.get(clientId) === socket.id) return socket.emit('client_reconnecting', { clientId });
      return socket.emit('session_blocked', 'This agent is offline right now');
    }
    // Busy with someone else — a live console, or a teammate whose console
    // dropped and is still inside its grace period.
    const holder = getSessionAgentName(clientId);
    if (holder && holder !== support.name && activeSessions.get(clientId) !== socket.id)
      return socket.emit('session_blocked', `Client is busy with ${holder}`);
    // One live session per console: moving on to another machine ends the
    // previous session instead of leaving that machine marked "in session".
    const previous = support.targetClientId;
    if (previous && previous !== clientId && activeSessions.get(previous) === socket.id) {
      support.targetClientId = null;      // so endSession does not bounce this console out of its new session
      activeSessions.delete(previous);
      dropHoldsForClient(previous);
      const prevData = clients.get(previous);
      if (prevData && prevData.socketId) { io.to(prevData.socketId).emit('session_ended', { reason: 'agent_switched' }); markSessionEndedSent(previous); }
      else if (prevData) strandedMachines.add(previous);
      console.log(`Session ended: ${previous} — reason: agent_switched`);
    }
    dropHoldsForClient(clientId);          // any earlier hold on this machine is superseded
    strandedMachines.delete(clientId);
    activeSessions.set(clientId, socket.id);
    support.targetClientId = clientId;
    sendSupportRequest(clientId, { supportId: socket.id, agentName: support.name });
    console.log(`Session started: ${support.name} -> ${clientId}`);
    broadcastClients();
  });

  socket.on('end_session', (clientId) => {
    // Only a logged-in support user may end a session, and only one they can
    // see: the person who holds it, or the product owner. Anything else could
    // tear down other people's sessions by guessing machine names.
    const sup = supports.get(socket.id);
    if (!sup || !canSeeAgent(sup, clientId) || !activeSessions.has(clientId)) return;
    const owner = activeSessions.get(clientId);
    const mine = owner === socket.id || getSessionAgentName(clientId) === sup.name;
    if (!mine && sup.role !== 'admin') return;
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
    const name = cleanName(data && data.name).slice(0, 40).trim();
    if (name.length < 2) return socket.emit('admin_error', 'Product name must be 2-40 characters');
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
      for (const n of affected)
        signOutUser(n, 'Your account has been suspended. Contact support@techsarasolutions.com.', 'owner_suspended');
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
    signOutUser(uname, 'Your password was reset. Please log in again with the new password.', 'password_reset');
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
    // Their consoles are signed out and their sessions ended BEFORE the
    // machines change hands.
    for (const n of toDelete) signOutUser(n, 'Your account was removed', 'account_removed');
    let moved = 0;
    for (const entry of Object.values(agents)) {
      if (!entry) continue;
      const inTenant = tenantId ? String(entry.tenantId || userTenantId(entry.owner)) === tenantId : (String(entry.owner || '') === uname);
      if (inTenant) { entry.owner = me; entry.tenantId = userTenantId(me) || me; moved++; }
    }
    if (moved) { persistAgents(); console.log(`Reassigned ${moved} agent(s) from tenant ${tenantId || uname} to ${me}`); }
    console.log(`Admin ${me} deleted customer ${uname} (${toDelete.length} account(s))`);
    socket.emit('admin_ok', `Customer "${uname}" deleted` + (moved ? ` -- ${moved} machine(s) moved to you` : ''));
    socket.emit('admin_users', publicUserList());
    broadcastClients();
  });

  // (Legacy admin_set_role removed: it changed only the stored role without
  // signing the account out or updating the tenant model, so a demoted owner's
  // open console kept its powers and a promoted team login broke isolation.
  // admin_delete_user already removes a co-owner and signs them out.)

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
    if (inSession(clientId)) return socket.emit('admin_error', 'Agent is in a live session — try again when idle');
    if (c.version === target) return socket.emit('admin_error', `Agent is already on ${target}`);
    const p = normPlatform(c.platform);
    pushedCanaries.add(clientId);
    // Decide downgrade per agent, not per platform: an agent AHEAD of its feed
    // (a straggler after a rollback) can only move by going back, whatever the
    // volatile rollbackMode flag says after a restart or a later activation.
    const allowDowngrade = rollbackMode[p] || cmpVersion(c.version, target) > 0;
    io.to(c.socketId).emit('check_update', { allowDowngrade });
    console.log(`AUDIT push_one by ${supports.get(socket.id).name} -> ${clientId} target ${target} (${p}, allowDowngrade=${allowDowngrade})`);
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
      if (inSession(id)) { skipped++; continue; }
      const p = normPlatform(c.platform);
      const target = targets[p];
      if (!target || c.version === target) continue;   // nothing staged, or already current
      if (!canaryHealthy[p]) { lockedPlatforms.add(p); continue; }  // platform not canary-cleared
      io.to(c.socketId).emit('check_update', { allowDowngrade: rollbackMode[p] || cmpVersion(c.version, target) > 0 });
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
    // Only an exact archived folder name — never a path like "1.4.1/../1.4.0"
    // that would escape the archive dir and publish arbitrary files as the feed.
    const v = String(version || '');
    if (!listArchivedVersions().includes(v)) return socket.emit('admin_error', 'Version not found in archive');
    let result;
    try { result = activateVersion(v); }
    catch (e) { console.error('activateVersion failed:', e && e.stack || e); return socket.emit('admin_error', 'Could not activate that version'); }
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
    if (inSession(clientId)) return;   // never delete an in-session client
    // Drop from persistent registry + live map + disconnect the client socket
    delete agents[clientId];
    persistAgents();
    const cd = clients.get(clientId);
    if (cd && cd.socketId) {
      io.to(cd.socketId).emit('deleted_by_admin');
      // Forget this socket's machine identity, so if it ignores the event and
      // stays connected it can no longer act as (a now-reused) "clientId".
      const s = io.sockets.sockets.get(cd.socketId);
      if (s) s.clientId = null;
    }
    clients.delete(clientId);
    activeSessions.delete(clientId);
    dropHoldsForClient(clientId);
    pushedCanaries.delete(clientId);   // a reused name must not inherit canary health
    strandedMachines.delete(clientId);
    lastSessionEndedAt.delete(clientId);
    console.log(`Agent ${clientId} deleted by ${supports.get(socket.id).name}`);
    broadcastClients();
  });

  socket.on('agent_logout', () => {
    if (!supports.has(socket.id)) return;
    const sup = supports.get(socket.id);
    if (sup.targetClientId && activeSessions.get(sup.targetClientId) === socket.id) endSession(sup.targetClientId, 'agent_logout');
    supports.delete(socket.id);
    // Invalidate the token the browser is holding, so Log out really ends the
    // session everywhere (a reconnect with the old token is refused).
    const user = getUser(sup.name);
    if (user) { user.sessionGen = (user.sessionGen || 0) + 1; persistUsers(); }
    console.log(`Support ${sup.name} logged out`);
    socket.emit('logout_ok');
    broadcastClients();
  });

  // The person at the machine pressed "Disconnect Session": the session is
  // over for good, including any console that was about to resume it.
  socket.on('client_disconnect', () => {
    if (!socket.clientId) return;
    const cd = clients.get(socket.clientId);
    if (!cd || cd.socketId !== socket.id) return;   // only the machine's current socket
    if (activeSessions.has(socket.clientId)) endSession(socket.clientId, 'client_ended');
    else dropHoldsForClient(socket.clientId);
  });

  // ── WebRTC relay ──
  // Only ever forwarded between the two parties of a live session, and only in
  // the direction each may send (machine → its console: offer/ice; console →
  // its machine: answer/ice). relayPeer() drops anything else — a socket that
  // is in no session, a forged or non-string target (an array target made
  // socket.io broadcast to every connection), or an oversized blob.
  socket.on('offer',         (data) => relayPeer(socket, 'offer', data));
  socket.on('answer',        (data) => relayPeer(socket, 'answer', data));
  socket.on('ice-candidate', (data) => relayPeer(socket, 'ice-candidate', data));

  socket.on('force_reset_all', () => {
    if (!requireAdmin(socket)) return;
    console.log('Force reset by', socket.id);
    // End each live session properly first: endSession() tells the MACHINE
    // (which otherwise keeps capturing and showing "is viewing your screen"),
    // tells the console, drops both holds and clears targetClientId.
    for (const id of Array.from(activeSessions.keys())) endSession(id, 'server_reset');
    for (const name of Array.from(reconnectTimers.keys())) dropSupportHold(name);
    for (const id of Array.from(clientReconnectTimers.keys())) dropClientHold(id);
    activeSessions.clear();
    for (const s of supports.values()) s.targetClientId = null;
    io.emit('server_reset');
    broadcastClients();
  });

  socket.on('disconnect', () => {
    console.log('Disconnected:', socket.id);

    // ── Client disconnected ──
    // A stale socket (the machine already reconnected on a newer one) must not
    // touch the machine's state — but it may ALSO be a console (a dual-role
    // socket), so fall through to the support cleanup instead of returning.
    if (socket.clientId) {
      const current = clients.get(socket.clientId);
      const stale = current && current.socketId && current.socketId !== socket.id;
      if (stale) {
        console.log(`Stale socket ${socket.id} for ${socket.clientId} closed — client already reconnected`);
      } else {
        const agentSocketId = activeSessions.get(socket.clientId);
        if (agentSocketId && supports.has(agentSocketId)) {
          // Mid-session: hold it so a restart or reboot resumes — for a while.
          holdClientSession(socket.clientId, agentSocketId);
          io.to(agentSocketId).emit('client_reconnecting', { clientId: socket.clientId });
          console.log(`Client ${socket.clientId} went offline — session held for ${Math.round(CLIENT_GRACE_MS / 1000)}s`);
        } else if (agentSocketId && !getSessionAgentName(socket.clientId)) {
          activeSessions.delete(socket.clientId);   // nobody holds it any more
        }
        // Mark offline but KEEP availability (persisted) so it comes back available.
        const clientData = clients.get(socket.clientId);
        if (clientData) clientData.socketId = null;
        broadcastClients();
      }
    }

    // ── Support disconnected ──
    if (supports.has(socket.id)) {
      const sup = supports.get(socket.id);
      supports.delete(socket.id);
      const clientId = sup.targetClientId;
      if (clientId && clients.has(clientId) && activeSessions.get(clientId) === socket.id) {
        // Mid-session: the machine stops sharing straight away, and the session
        // is held briefly so a reload or a network blip can pick it back up.
        const clientData = clients.get(clientId);
        if (clientData && clientData.socketId) io.to(clientData.socketId).emit('agent_reconnecting', { agentName: sup.name });
        holdSupportSession(sup.name, clientId);
        console.log(`Support ${sup.name} disconnected — session with ${clientId} held for ${Math.round(SUPPORT_GRACE_MS / 1000)}s`);
      }
      broadcastClients();
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
