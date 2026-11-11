// E2E for the hardening round: session tokens, sign-in throttle, tenant
// integrity, and the live-session lifecycle (holds with a grace period,
// takeover rules, sign-in elsewhere, machine switching).
// Server on :3998, owner paras/ownerpass123, started with
//   SUPPORT_GRACE_MS=1500 CLIENT_GRACE_MS=2500
const { io } = require(require('path').join(__dirname, '..', 'client', 'node_modules', 'socket.io-client'));
const http = require('http');
const URL = process.env.DL_TEST_URL || 'http://127.0.0.1:3998';
const R = []; const check = (n, c) => { R.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
function once(s, ev, t = 4000) { return new Promise((res, rej) => { const h = setTimeout(() => rej(new Error('timeout ' + ev)), t); s.once(ev, d => { clearTimeout(h); res(d === undefined ? true : d); }); }); }
const maybe = (s, ev, t = 700) => once(s, ev, t).catch(() => null);   // null = it did not happen
const conn = async () => { const s = io(URL, { transports: ['websocket'], reconnection: false }); await once(s, 'connect'); return s; };

async function register(payload) {
  const s = await conn();
  const ok = once(s, 'login_success').then(d => ({ ok: d })).catch(() => null);
  const err = once(s, 'login_error').then(d => ({ err: d })).catch(() => null);
  s.emit('register', Object.assign({ type: 'support' }, payload));
  const res = await Promise.race([ok, err]);
  return { s, ok: res && res.ok, err: res && res.err };
}
async function support(username, password) {
  const r = await register({ username, password });
  if (!r.ok) throw new Error('login failed for ' + username + ': ' + r.err);
  r.s.info = r.ok;
  return r.s;
}
const list = (sup) => new Promise((res, rej) => {
  const h = setTimeout(() => rej(new Error('timeout clients_list')), 4000);
  sup.once('clients_list', (l) => { clearTimeout(h); res(l); });
  sup.emit('list_clients');
});
const find = async (sup, id) => (await list(sup)).find(c => c.id === id);
async function slot(sup, name) {
  sup.emit('create_agent_slot', { name });
  const d = await once(sup, 'agent_slot_created');
  return d.code.replace(/\D/g, '');
}
// Installs a 1.4.1 agent; returns its socket + secret.
async function machine(sup, name, platform = 'win32') {
  const code = await slot(sup, name);
  const s = await conn();
  const bound = once(s, 'client_bound');
  const av = once(s, 'availability_state');
  s.emit('register', { type: 'client', clientId: name, appVersion: '1.4.1', platform, installCode: code });
  const secret = (await bound).secret;
  await av;
  return { s, secret, name, platform };
}
async function machineBack(m) {
  const s = await conn();
  const av = once(s, 'availability_state');
  s.emit('register', { type: 'client', clientId: m.name, appVersion: '1.4.1', platform: m.platform, secret: m.secret });
  await av;
  m.s = s;
  return s;
}
const get = (path) => new Promise((res, rej) => {
  http.get(URL + path, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: b })); }).on('error', rej);
});

(async () => {
  const admin = await support('paras', 'ownerpass123');
  const mkCustomer = async (displayName, teamLimit) => { admin.emit('admin_create_customer', { displayName, teamLimit }); return once(admin, 'customer_created'); };
  const mkMember = async (own, displayName) => { own.emit('team_create', { displayName }); return once(own, 'team_member_created'); };

  // ══════════ HTTP surface ══════════
  const home = await get('/');
  check('HTTP: landing page served', home.status === 200 && /<title>/.test(home.body));
  check('HTTP: strict Content-Security-Policy (no inline script, no third parties)',
    /script-src 'self'(;|$)/.test(home.headers['content-security-policy'] || '') && /frame-ancestors 'none'/.test(home.headers['content-security-policy'] || ''));
  check('HTTP: nosniff + frame deny + referrer policy', home.headers['x-content-type-options'] === 'nosniff' && home.headers['x-frame-options'] === 'DENY' && !!home.headers['referrer-policy']);
  check('HTTP: no X-Powered-By', !home.headers['x-powered-by']);
  const dash = await get('/dashboard');
  check('HTTP: console page has no inline <script>', dash.status === 200 && !/<script(?![^>]*\bsrc=)[^>]*>/i.test(dash.body));
  check('HTTP: console loads no third-party origin', !/(src|href)="https?:\/\//i.test(dash.body));
  const dl = await get('/api/downloads');
  const dlj = JSON.parse(dl.body);
  check('HTTP: /api/downloads reports installer availability', dl.status === 200 && dlj.windows && dlj.windows.available === true && dlj.windows.version === '1.4.1' && dlj.mac && typeof dlj.mac.available === 'boolean');
  check('HTTP: path traversal is refused', (await get('/..%2fserver.js')).status === 404 && (await get('/%2e%2e/data/users.json')).status === 404 && (await get('/.env')).status === 404);
  check('HTTP: data directory is not reachable', (await get('/data/users.json')).status === 404);
  const font = await get('/fonts/inter-latin.woff2');
  check('HTTP: fonts are self-hosted and cached immutably', font.status === 200 && /immutable/.test(font.headers['cache-control'] || ''));
  check('HTTP: socket.io client is served from this origin', (await get('/socket.io/socket.io.min.js')).status === 200);
  const nf = await get('/no-such-path-xyz');
  check('HTTP: unknown paths return a plain 404 with no server path or stack trace',
    nf.status === 404 && !/node_modules|Cannot GET|ENOENT| at |\/opt\/|[A-Za-z]:\\/.test(nf.body));

  // ══════════ A. SESSION TOKENS ══════════
  const acme = await mkCustomer('Acme Retail', 5);
  const first = await register({ username: acme.username, password: acme.password });
  check('A: password sign-in returns a session token', first.ok && /^v1\./.test(first.ok.token) && first.ok.session === null && !!first.ok.boot);
  check('A: the token never contains the password', first.ok && !first.ok.token.includes(acme.password));
  const kickedP = maybe(first.s, 'force_logout', 1500);
  const viaToken = await register({ username: acme.username, token: first.ok.token });
  check('A: a console can sign back in with the token alone', !!viaToken.ok && viaToken.ok.isTenantOwner === true);
  const kicked = await kickedP;
  check('A: the older console of the same login is told it was signed out', typeof kicked === 'string' && /another window or device/i.test(kicked));
  const tampered = first.ok.token.slice(0, -3) + (first.ok.token.endsWith('AAA') ? 'BBB' : 'AAA');
  const bad1 = await register({ username: acme.username, token: tampered });
  check('A: a tampered token is rejected', !bad1.ok && /expired|sign in/i.test(bad1.err || ''));
  const bad2 = await register({ username: 'paras', token: first.ok.token });
  check('A: a token cannot be used for another account', !bad2.ok && !!bad2.err);
  const parts = first.ok.token.split('.');
  const forged = ['v1', parts[1], String(Date.now() + 9e9), parts[3]].join('.');
  check('A: extending the expiry breaks the signature', !(await register({ username: acme.username, token: forged })).ok);
  const refreshed = once(viaToken.s, 'session_token');
  viaToken.s.emit('refresh_session');
  const fresh = await refreshed;
  check('A: an open console can refresh its token', fresh && /^v1\./.test(fresh.token) && !!(await register({ username: acme.username, token: fresh.token })).ok);
  const anon = await conn();
  anon.emit('refresh_session');
  check('A: an unauthenticated socket gets no token', (await maybe(anon, 'session_token', 500)) === null);
  anon.emit('list_clients');
  check('A: an unauthenticated socket gets no agent list', (await maybe(anon, 'clients_list', 500)) === null);
  anon.disconnect();

  // password reset invalidates every outstanding token
  const live = await register({ username: acme.username, token: fresh.token });
  const liveKick = once(live.s, 'force_logout');
  admin.emit('admin_reset_password', { username: acme.username });
  const reset = await once(admin, 'password_reset_ok');
  await liveKick;
  check('A: a password reset invalidates outstanding tokens', !(await register({ username: acme.username, token: live.ok.token })).ok);
  check('A: the old password no longer works', !(await register({ username: acme.username, password: acme.password })).ok);
  acme.password = reset.password;
  const acmeOwner = await support(acme.username, acme.password);
  check('A: the new password works', !!acmeOwner.info);

  // suspension blocks token sign-in too
  const globex = await mkCustomer('Globex Corporation', 2);
  const g1 = await register({ username: globex.username, password: globex.password });
  admin.emit('admin_suspend_user', { username: globex.username, suspended: true });
  await once(admin, 'admin_ok');
  const susp = await register({ username: globex.username, token: g1.ok.token });
  check('A: a suspended customer cannot sign in with a token either', !susp.ok && /suspend/i.test(susp.err || ''));
  admin.emit('admin_suspend_user', { username: globex.username, suspended: false });
  await once(admin, 'admin_ok');
  const globexOwner = await support(globex.username, globex.password);

  // ══════════ B. SIGN-IN THROTTLE ══════════
  const victim = await mkCustomer('Throttle Target', 0);
  let lastErr = '';
  for (let i = 0; i < 8; i++) { const r = await register({ username: victim.username, password: 'wrong-' + i }); lastErr = r.err; r.s.disconnect(); }
  check('B: wrong passwords are answered with a generic error', /invalid username or password/i.test(lastErr));
  const locked = await register({ username: victim.username, password: victim.password });
  check('B: after 8 failures further attempts are throttled (even the right password)', !locked.ok && /too many/i.test(locked.err || ''));
  locked.s.disconnect();
  const bystander = await mkCustomer('Bystander Co', 0);
  const other = await register({ username: bystander.username, password: bystander.password });
  check('B: the throttle is per account — other logins are unaffected', !!other.ok);
  other.s.disconnect();
  const ghost = await register({ username: 'no-such-user', password: 'x' });
  check('B: unknown users get the same generic error', /invalid username or password/i.test(ghost.err || ''));
  ghost.s.disconnect();

  // ══════════ C. TENANT INTEGRITY ══════════
  const priya = await mkMember(acmeOwner, 'Priya Sharma');
  const rahul = await mkMember(acmeOwner, 'Rahul Verma');
  let priyaS = await support(priya.username, priya.password);
  const pc1 = await machine(priyaS, 'Acme-PC1');           // installed by a TEAM MEMBER
  const pc2 = await machine(acmeOwner, 'Acme-PC2');
  const mac1 = await machine(acmeOwner, 'Acme-Mac1', 'darwin');
  const gpc = await machine(globexOwner, 'Globex-PC1');
  // re-register (app restart): the tenant must survive
  pc1.s.disconnect(); await wait(150); await machineBack(pc1);
  admin.emit('admin_list_users');
  let users = await once(admin, 'admin_users');
  const row = (id) => users.find(u => u.customerId === id);
  check('C: Owner Console counts every machine of the customer (3)', row('TS-0001') && row('TS-0001').agentCount === 3);
  check('C: and of the other customer (1)', row('TS-0002') && row('TS-0002').agentCount === 1);
  check('C: team seats are counted (2 of 5)', row('TS-0001').teamCount === 2 && row('TS-0001').teamLimit === 5);
  check('C: the machine is tagged with its organization', (await find(acmeOwner, 'Acme-PC1')).tenantId === 'TS-0001');
  check('C: the team member sees all three org machines', (await list(priyaS)).filter(c => /^Acme-/.test(c.id)).length === 3);
  check('C: the other customer sees none of them', !(await list(globexOwner)).some(c => /^Acme-/.test(c.id)));
  // remove the team member who installed PC1 → the machine stays with the org
  const priyaKick = once(priyaS, 'force_logout');
  acmeOwner.emit('team_remove', { username: priya.username });
  await once(acmeOwner, 'team_ok');
  await priyaKick;
  const kept = await find(acmeOwner, 'Acme-PC1');
  check('C: removing a team member keeps the machines they installed', !!kept && kept.tenantId === 'TS-0001' && kept.owner === acme.username);
  check('C: the removed member can no longer sign in', !(await register({ username: priya.username, password: priya.password })).ok);
  pc1.s.disconnect(); await wait(150); await machineBack(pc1);
  check('C: still with the org after the machine reconnects', (await find(acmeOwner, 'Acme-PC1')).tenantId === 'TS-0001');
  check('C: still invisible to the other customer', !(await list(globexOwner)).some(c => c.id === 'Acme-PC1'));
  admin.emit('admin_list_users');
  users = await once(admin, 'admin_users');
  check('C: counts stay right after the removal', row('TS-0001').agentCount === 3 && row('TS-0001').teamCount === 1);

  // Customer IDs are never reused
  const tmp = await mkCustomer('Temp Co', 0);
  admin.emit('admin_delete_user', { username: tmp.username });
  await once(admin, 'admin_ok');
  const after = await mkCustomer('After Temp', 0);
  check('C: a deleted customer\'s ID is never issued again', parseInt(after.customerId.slice(3), 10) > parseInt(tmp.customerId.slice(3), 10));

  // ══════════ D. LIVE-SESSION LIFECYCLE ══════════
  let rahulS = await support(rahul.username, rahul.password);
  const reqConn = async (sup, id) => {
    const blocked = maybe(sup, 'session_blocked', 600);
    sup.emit('request_connection', id);
    return blocked;                                   // null = accepted
  };

  // D1. busy rules inside a team
  let reqSeen = once(pc1.s, 'support_request');
  check('D1: team member starts a session', (await reqConn(rahulS, 'Acme-PC1')) === null && (await reqSeen).agentName === rahul.username);
  let st = await find(acmeOwner, 'Acme-PC1');
  check('D1: teammates see the machine in session with that person', st.isBusy === true && st.agentName === rahul.username);
  check('D1: a teammate cannot barge in', /busy with/i.test(await reqConn(acmeOwner, 'Acme-PC1') || ''));
  check('D1: another customer cannot reach it at all', /another support user/i.test(await reqConn(globexOwner, 'Acme-PC1') || ''));
  globexOwner.emit('end_session', 'Acme-PC1');
  acmeOwner.emit('end_session', 'Acme-PC1');
  await wait(250);
  check('D1: nobody but the holder (or the product owner) can end it', (await find(acmeOwner, 'Acme-PC1')).isBusy === true);

  // D2. the console drops → held for a grace period → released
  const pcReconnecting = once(pc1.s, 'agent_reconnecting');
  let pcEnded = once(pc1.s, 'session_ended', 5000);
  rahulS.disconnect();
  check('D2: the machine is told its viewer dropped (it stops sharing)', !!(await pcReconnecting));
  st = await find(acmeOwner, 'Acme-PC1');
  check('D2: during the grace period it is still held for that person', st.isBusy === true && st.agentName === rahul.username);
  check('D2: and a teammate still cannot take it', /busy with/i.test(await reqConn(acmeOwner, 'Acme-PC1') || ''));
  const endInfo = await pcEnded;
  check('D2: when the grace period ends the session is closed on the machine', endInfo && endInfo.reason === 'agent_timeout');
  st = await find(acmeOwner, 'Acme-PC1');
  check('D2: and the machine is free again — never stuck "in session"', st.isBusy === false && st.agentName === null && st.available === true);

  // D3. a teammate takes it; the first person coming back must not steal it
  reqSeen = once(pc1.s, 'support_request');
  check('D3: a teammate can now connect', (await reqConn(acmeOwner, 'Acme-PC1')) === null && (await reqSeen).agentName === acme.username);
  const back = await register({ username: rahul.username, password: rahul.password });
  rahulS = back.s;
  check('D3: the first person signs back in with no session', back.ok && back.ok.session === null && (await maybe(rahulS, 'session_restored', 500)) === null);
  st = await find(acmeOwner, 'Acme-PC1');
  check('D3: the teammate\'s session is untouched', st.isBusy === true && st.agentName === acme.username);
  pcEnded = once(pc1.s, 'session_ended');
  acmeOwner.emit('end_session', 'Acme-PC1');
  check('D3: the holder ends it normally', (await pcEnded).reason === 'agent_ended');

  // D4. the console comes back inside the grace period → session resumes
  reqSeen = once(pc2.s, 'support_request');
  await reqConn(rahulS, 'Acme-PC2'); await reqSeen;
  const tokenR = rahulS.info ? rahulS.info.token : back.ok.token;
  rahulS.disconnect(); await wait(300);
  reqSeen = once(pc2.s, 'support_request');
  const resumed = await conn();
  const restoredP = once(resumed, 'session_restored');
  const okP = once(resumed, 'login_success');
  resumed.emit('register', { type: 'support', username: rahul.username, token: tokenR });
  const okInfo = await okP;
  check('D4: back within the grace period → the session is restored', (await restoredP).clientId === 'Acme-PC2' && okInfo.session === 'Acme-PC2');
  check('D4: and the machine restarts the stream to the new connection', (await reqSeen).supportId === resumed.id);
  rahulS = resumed;
  await wait(1800);   // past the old grace deadline
  st = await find(acmeOwner, 'Acme-PC2');
  check('D4: a restored session is not cut off by the old timer', st.isBusy === true && st.agentName === rahul.username);

  // D5. ended while the console was away → never resurrected
  rahulS.disconnect(); await wait(200);
  pcEnded = once(pc2.s, 'session_ended');
  admin.emit('end_session', 'Acme-PC2');
  check('D5: the product owner can end a held session', (await pcEnded).reason === 'agent_ended');
  const back2 = await register({ username: rahul.username, token: okInfo.token });
  rahulS = back2.s;
  check('D5: it is not restored when the person returns', back2.ok && back2.ok.session === null && (await maybe(rahulS, 'session_restored', 500)) === null);
  check('D5: the machine stays free', (await find(acmeOwner, 'Acme-PC2')).isBusy === false);

  // D6. moving to another machine ends the first session
  reqSeen = once(pc1.s, 'support_request'); await reqConn(rahulS, 'Acme-PC1'); await reqSeen;
  const pc1Ended = once(pc1.s, 'session_ended');
  const bounced = maybe(rahulS, 'session_ended', 700);
  reqSeen = once(pc2.s, 'support_request'); await reqConn(rahulS, 'Acme-PC2'); await reqSeen;
  check('D6: switching machines ends the first session on that machine', (await pc1Ended).reason === 'agent_switched');
  check('D6: the console is not bounced out of its new session', (await bounced) === null);
  const both = await list(acmeOwner);
  check('D6: only the new machine is in session', both.find(c => c.id === 'Acme-PC1').isBusy === false && both.find(c => c.id === 'Acme-PC2').isBusy === true);

  // D7. signing in elsewhere with the password ends the older console
  const oldKick = once(rahulS, 'force_logout');
  pcEnded = once(pc2.s, 'session_ended');
  const second = await register({ username: rahul.username, password: rahul.password });
  check('D7: the older console is signed out with an explanation', /another window or device/i.test(await oldKick));
  check('D7: its session ends on the machine', (await pcEnded).reason === 'signed_in_elsewhere');
  check('D7: the new console starts clean', second.ok && second.ok.session === null && (await find(acmeOwner, 'Acme-PC2')).isBusy === false);
  rahulS.disconnect(); rahulS = second.s;

  // D8. same console on a new socket before the old one is noticed dead → the session moves across
  reqSeen = once(pc1.s, 'support_request'); await reqConn(rahulS, 'Acme-PC1'); await reqSeen;
  reqSeen = once(pc1.s, 'support_request');
  const moved = await conn();
  const movedRestored = once(moved, 'session_restored');
  moved.emit('register', { type: 'support', username: rahul.username, token: second.ok.token });
  check('D8: a token re-register carries the live session to the new socket', (await movedRestored).clientId === 'Acme-PC1' && (await reqSeen).supportId === moved.id);
  st = await find(acmeOwner, 'Acme-PC1');
  check('D8: the machine stays in session throughout', st.isBusy === true && st.agentName === rahul.username);
  rahulS.disconnect(); await wait(300);
  check('D8: the old socket closing afterwards changes nothing', (await find(acmeOwner, 'Acme-PC1')).isBusy === true);
  rahulS = moved;

  // D9. the MACHINE drops mid-session and returns → resumes (with consent flag)
  const recon = once(rahulS, 'client_reconnecting');
  pc1.s.disconnect();
  check('D9: the console is told the machine went offline', (await recon).clientId === 'Acme-PC1');
  await wait(300);
  const backOnline = once(rahulS, 'client_reconnected');
  const s2 = await conn();
  const restoreReq = once(s2, 'support_request');
  s2.emit('register', { type: 'client', clientId: 'Acme-PC1', appVersion: '1.4.1', platform: 'win32', secret: pc1.secret });
  const rr = await restoreReq; pc1.s = s2;
  check('D9: the machine is asked to resume, flagged as a restore', rr.restored === true && rr.supportId === rahulS.id);
  check('D9: the console is told it is back', (await backOnline).clientId === 'Acme-PC1');

  // D10. the machine drops and does NOT return → released after its grace period
  const timedOut = once(rahulS, 'session_ended', 6000);
  pc1.s.disconnect();
  const t = await timedOut;
  check('D10: a machine that stays away is released', t.clientId === 'Acme-PC1' && t.reason === 'client_timeout');
  check('D10: requesting an offline machine is refused', /offline/i.test(await reqConn(rahulS, 'Acme-PC1') || ''));
  await machineBack(pc1);
  st = await find(acmeOwner, 'Acme-PC1');
  check('D10: it comes back Available and free', st.online && st.available && !st.isBusy);

  // D11. the person at the machine ends the session → final, even for a held console
  reqSeen = once(pc1.s, 'support_request'); await reqConn(rahulS, 'Acme-PC1'); await reqSeen;
  const tok11 = (await new Promise(res => { rahulS.once('session_token', res); rahulS.emit('refresh_session'); })).token;
  rahulS.disconnect(); await wait(200);
  pc1.s.emit('client_disconnect');
  await wait(250);
  const back11 = await register({ username: rahul.username, token: tok11 });
  rahulS = back11.s;
  check('D11: "Disconnect Session" on the machine is final', back11.ok && back11.ok.session === null && (await find(acmeOwner, 'Acme-PC1')).isBusy === false);

  // D12. resetting a member's password ends their live session
  reqSeen = once(mac1.s, 'support_request'); await reqConn(rahulS, 'Acme-Mac1'); await reqSeen;
  pcEnded = once(mac1.s, 'session_ended');
  const rkick = once(rahulS, 'force_logout');
  acmeOwner.emit('team_reset_password', { username: rahul.username });
  const newPw = await once(acmeOwner, 'team_password_reset');
  check('D12: a password reset signs the member out', /password was reset/i.test(await rkick));
  check('D12: and ends their live session on the machine', (await pcEnded).reason === 'password_reset');
  check('D12: the machine is free', (await find(acmeOwner, 'Acme-Mac1')).isBusy === false);
  rahulS.disconnect();
  rahulS = await support(rahul.username, newPw.password);

  // D13. suspending a customer ends its sessions; deleting it moves machines safely
  reqSeen = once(gpc.s, 'support_request'); await reqConn(globexOwner, 'Globex-PC1'); await reqSeen;
  pcEnded = once(gpc.s, 'session_ended');
  admin.emit('admin_suspend_user', { username: globex.username, suspended: true });
  await once(admin, 'admin_ok');
  check('D13: suspending a customer ends its live session', (await pcEnded).reason === 'owner_suspended');
  check('D13: the product owner sees the machine free', (await find(admin, 'Globex-PC1')).isBusy === false);

  // D14. the product owner sees everything and can reset stuck state
  const all = await list(admin);
  check('D14: the product owner sees every customer\'s machines', ['Acme-PC1', 'Acme-PC2', 'Acme-Mac1', 'Globex-PC1'].every(id => all.some(c => c.id === id)));
  check('D14: platforms are reported per machine', all.find(c => c.id === 'Acme-Mac1').platform === 'mac' && all.find(c => c.id === 'Acme-PC1').platform === 'win');

  const fails = R.filter(x => !x).length;
  console.log(`\n${R.length - fails}/${R.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('E2E error:', e.message, e.stack); const fails = R.filter(x => !x).length; console.log(`\n(aborted) ${R.length - fails}/${R.length} passed before the error`); process.exit(1); });
