// Multi-tenant E2E: owner console, customer isolation, suspend/enable,
// password reset, and tenant-isolation guards. Server on :3998.
const { io } = require(require('path').join(__dirname, '..', 'client', 'node_modules', 'socket.io-client'));
const URL = process.env.DL_TEST_URL || 'http://127.0.0.1:3998';
const R = []; const check = (n, c) => { R.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
function once(s, ev, t = 4000) { return new Promise((res, rej) => { const h = setTimeout(() => rej(new Error('timeout ' + ev)), t); s.once(ev, d => { clearTimeout(h); res(d); }); }); }
const conn = async () => { const s = io(URL, { transports: ['websocket'] }); await once(s, 'connect'); return s; };
const login = async (username, password) => {
  const s = await conn();
  const okP = once(s, 'login_success').then(d => ({ ok: d })).catch(() => null);
  const errP = once(s, 'login_error').then(d => ({ err: d })).catch(() => null);
  s.emit('register', { type: 'support', username, password });
  const res = await Promise.race([okP, errP]);
  return { s, res };
};

(async () => {
  // ── Owner login ──
  const owner = await login('paras', 'ownerpass123');
  check('Owner logs in as admin', owner.res.ok && owner.res.ok.role === 'admin');
  const admin = owner.s;

  // ── Create two customers ──
  admin.emit('admin_create_customer', { displayName: 'Acme Retail' });
  const c1 = await once(admin, 'customer_created');
  admin.emit('admin_create_customer', { displayName: 'Globex Corp' });
  const c2 = await once(admin, 'customer_created');
  check('Customer 1 created with TS-0001 + password', c1.customerId === 'TS-0001' && c1.username === 'ts-0001' && c1.password && c1.password.length >= 8);
  check('Customer 2 created with TS-0002', c2.customerId === 'TS-0002' && c2.username === 'ts-0002');

  // ── Customer 1 logs in with issued creds ──
  const cust1 = await login(c1.username, c1.password);
  check('Customer 1 logs in with issued password', cust1.res.ok && cust1.res.ok.role === 'support');
  check('Customer 1 login carries its Customer ID + name', cust1.res.ok.customerId === 'TS-0001' && cust1.res.ok.displayName === 'Acme Retail');

  // ── Customer 1 creates an agent slot (owned by ts-0001) ──
  cust1.s.emit('create_agent_slot', { name: 'Acme-Reception' });
  await once(cust1.s, 'agent_slot_created');
  // capture customer 1's own agent list
  const c1list = await once(cust1.s, 'clients_list');
  check('Customer 1 sees its own machine', c1list.some(a => a.id === 'Acme-Reception'));

  // ── Customer 2 logs in — must NOT see customer 1's machine ──
  const cust2 = await login(c2.username, c2.password);
  check('Customer 2 logs in', cust2.res.ok && cust2.res.ok.customerId === 'TS-0002');
  const c2list = await once(cust2.s, 'clients_list');
  check('ISOLATION: customer 2 does NOT see customer 1\'s machine', !c2list.some(a => a.id === 'Acme-Reception'));
  check('ISOLATION: customer 2 sees an empty fleet', c2list.length === 0);

  // ── Isolation guard: customer cannot enumerate other customers ──
  let gotUsers = false;
  cust2.s.on('support_users', () => { gotUsers = true; });
  cust2.s.emit('list_support_users');
  await wait(400);
  check('ISOLATION: customer cannot list other customers', gotUsers === false);

  // ── Isolation guard: customer cannot reassign a machine ──
  cust1.s.emit('transfer_agent', { clientId: 'Acme-Reception', to: 'ts-0002' });
  const trErr = await once(cust1.s, 'agent_transfer_error');
  check('ISOLATION: customer cannot reassign a machine', /owner/i.test(trErr));

  // owner CAN see the whole fleet (both customers' machines)
  const ownerList = await new Promise(res => { admin.once('clients_list', res); admin.emit('create_agent_slot', { name: 'Owner-ping' }); });
  check('Owner sees the whole fleet', ownerList.some(a => a.id === 'Acme-Reception'));
  admin.emit('remove_client', 'Owner-ping');

  // ── Suspend customer 1 ──
  const c1kick = once(cust1.s, 'force_logout');
  admin.emit('admin_suspend_user', { username: 'ts-0001', suspended: true });
  await once(admin, 'admin_ok').catch(() => {});
  const kicked = await c1kick;
  check('Suspend: customer 1 is force-logged-out', !!kicked);
  // suspended customer cannot log back in
  const relog = await login('ts-0001', c1.password);
  check('Suspend: suspended customer cannot log in', relog.res && relog.res.err && /suspend/i.test(relog.res.err));
  relog.s.disconnect();

  // ── Re-enable customer 1 ──
  admin.emit('admin_suspend_user', { username: 'ts-0001', suspended: false });
  await once(admin, 'admin_ok');
  const reon = await login('ts-0001', c1.password);
  check('Enable: re-enabled customer can log in again', reon.res && reon.res.ok && reon.res.ok.customerId === 'TS-0001');

  // ── Reset customer 1 password ──
  const rkick = once(reon.s, 'force_logout');
  admin.emit('admin_reset_password', { username: 'ts-0001' });
  const resetInfo = await once(admin, 'password_reset_ok');
  check('Reset: owner receives a new generated password', resetInfo.password && resetInfo.password.length >= 8 && resetInfo.customerId === 'TS-0001');
  await rkick.catch(() => {});
  // old password now fails, new one works
  const oldTry = await login('ts-0001', c1.password);
  check('Reset: OLD password no longer works', oldTry.res && oldTry.res.err);
  oldTry.s.disconnect();
  const newTry = await login('ts-0001', resetInfo.password);
  check('Reset: NEW password works', newTry.res && newTry.res.ok);
  newTry.s.disconnect();

  // ── Delete customer 2 (no agents) ──
  admin.emit('admin_delete_user', { username: 'ts-0002' });
  await once(admin, 'admin_ok');
  const delTry = await login('ts-0002', c2.password);
  check('Delete: deleted customer cannot log in', delTry.res && delTry.res.err);
  delTry.s.disconnect();

  // cleanup
  admin.emit('remove_client', 'Acme-Reception');
  admin.emit('admin_delete_user', { username: 'ts-0001' });
  await wait(400);
  [cust1.s, cust2.s, reon.s, admin].forEach(s => { try { s.disconnect(); } catch (_) {} });

  const fails = R.filter(x => !x).length;
  console.log(`\n${R.length - fails}/${R.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('E2E error:', e.message, e.stack); process.exit(1); });
