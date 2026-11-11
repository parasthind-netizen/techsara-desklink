// Team (org sub-users) E2E: a customer creates team-member logins that share
// the org's machines; isolation across customers; reset/remove; suspend cascade.
const { io } = require(require('path').join(__dirname, '..', 'client', 'node_modules', 'socket.io-client'));
const URL = process.env.DL_TEST_URL || 'http://127.0.0.1:3998';
const R = []; const check = (n, c) => { R.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
function once(s, ev, t = 4000) { return new Promise((res, rej) => { const h = setTimeout(() => rej(new Error('timeout ' + ev)), t); s.once(ev, d => { clearTimeout(h); res(d); }); }); }
const conn = async () => { const s = io(URL, { transports: ['websocket'] }); await once(s, 'connect'); return s; };
const login = async (u, p) => {
  const s = await conn();
  const ok = once(s, 'login_success').then(d => ({ ok: d })).catch(() => null);
  const err = once(s, 'login_error').then(d => ({ err: d })).catch(() => null);
  s.emit('register', { type: 'support', username: u, password: p });
  return { s, res: await Promise.race([ok, err]) };
};

(async () => {
  const admin = await conn();
  admin.emit('register', { type: 'support', username: 'paras', password: 'ownerpass123' });
  await once(admin, 'login_success');

  // owner creates two customers
  admin.emit('admin_create_customer', { displayName: 'Acme Retail' });
  const c1 = await once(admin, 'customer_created');
  admin.emit('admin_create_customer', { displayName: 'Globex' });
  const c2 = await once(admin, 'customer_created');

  // customer 1 logs in (tenant owner) and creates a machine
  const own1 = await login(c1.username, c1.password);
  check('customer logs in as tenant owner', own1.res.ok && own1.res.ok.isTenantOwner === true);
  own1.s.emit('create_agent_slot', { name: 'Acme-PC1' });
  await once(own1.s, 'agent_slot_created');
  await once(own1.s, 'clients_list');

  // customer 1 creates TWO team members
  own1.s.emit('team_create', { displayName: 'Priya' });
  const t1 = await once(own1.s, 'team_member_created');
  own1.s.emit('team_create', { displayName: 'Rahul' });
  const t2 = await once(own1.s, 'team_member_created');
  check('team member 1 gets a login+password', t1.username === 'ts-0001-u2' && t1.password.length >= 8);
  check('team member 2 gets next login', t2.username === 'ts-0001-u3');

  // team list shows the two members (not the owner)
  const list1 = await once(own1.s, 'team_list');
  check('team_list shows the 2 team members', list1.filter(m => !m.isTenantOwner).length === 2);

  // team member logs in and sees the SAME org machine
  const tm1 = await login(t1.username, t1.password);
  check('team member logs in (not tenant owner)', tm1.res.ok && tm1.res.ok.isTenantOwner === false && tm1.res.ok.tenantId === 'TS-0001');
  const tmList = await once(tm1.s, 'clients_list');
  check('TEAM SHARING: team member sees the org machine Acme-PC1', tmList.some(a => a.id === 'Acme-PC1'));

  // team member can create a machine too, and it stays in the same tenant
  tm1.s.emit('create_agent_slot', { name: 'Acme-PC2' });
  await once(tm1.s, 'agent_slot_created');
  await wait(200);
  const ownAfter = await new Promise(res => { own1.s.once('clients_list', res); own1.s.emit('create_agent_slot', { name: 'Acme-ping' }); });
  check('owner sees machine created by team member (same tenant)', ownAfter.some(a => a.id === 'Acme-PC2'));
  own1.s.emit('remove_client', 'Acme-ping');

  // ISOLATION: customer 2 and its team see NONE of customer 1's machines
  const own2 = await login(c2.username, c2.password);
  const c2list = await once(own2.s, 'clients_list');
  check('ISOLATION: other customer sees none of org 1 machines', !c2list.some(a => String(a.id).startsWith('Acme')) && c2list.length === 0);

  // GUARD: a team member cannot create more team members
  tm1.s.emit('team_create', { displayName: 'Sneaky' });
  const gErr = await once(tm1.s, 'team_error');
  check('GUARD: team member cannot create team members', /only your main account/i.test(gErr));

  // reset a team member's password (by owner): old fails, new works
  const rkick = once(tm1.s, 'force_logout');
  own1.s.emit('team_reset_password', { username: t1.username });
  const rp = await once(own1.s, 'team_password_reset');
  await rkick.catch(() => {});
  const oldTry = await login(t1.username, t1.password);
  check('reset: team member OLD password fails', oldTry.res && oldTry.res.err);
  oldTry.s.disconnect();
  const newTry = await login(t1.username, rp.password);
  check('reset: team member NEW password works', newTry.res && newTry.res.ok);

  // remove team member 2: their login stops working
  own1.s.emit('team_remove', { username: t2.username });
  await once(own1.s, 'team_ok');
  const remTry = await login(t2.username, t2.password);
  check('remove: removed team member cannot log in', remTry.res && remTry.res.err);
  remTry.s.disconnect();

  // SUSPEND CASCADE: owner suspends customer 1 -> owner AND remaining team member blocked
  admin.emit('admin_suspend_user', { username: c1.username, suspended: true });
  await once(admin, 'admin_ok');
  const ownerBlocked = await login(c1.username, c1.password);
  const teamBlocked = await login(t1.username, rp.password);
  check('SUSPEND CASCADE: customer owner blocked', ownerBlocked.res && ownerBlocked.res.err && /suspend/i.test(ownerBlocked.res.err));
  check('SUSPEND CASCADE: team member also blocked', teamBlocked.res && teamBlocked.res.err && /suspend/i.test(teamBlocked.res.err));
  ownerBlocked.s.disconnect(); teamBlocked.s.disconnect();

  // re-enable restores both
  admin.emit('admin_suspend_user', { username: c1.username, suspended: false });
  await once(admin, 'admin_ok');
  const reTeam = await login(t1.username, rp.password);
  check('ENABLE CASCADE: team member can log in again', reTeam.res && reTeam.res.ok);
  reTeam.s.disconnect();

  // owner console lists ONLY tenant owners (2 customers), not team members
  admin.emit('admin_list_users');
  const users = await once(admin, 'admin_users');
  const owners = users.filter(u => u.role !== 'admin' && u.isTenantOwner);
  const members = users.filter(u => u.role === 'support' && !u.isTenantOwner);
  check('owner console: 2 customers (tenant owners)', owners.length === 2);
  check('owner console: team members exist but are separate', members.length >= 1 && owners.every(o => o.teamCount >= 0));

  // cleanup
  for (const id of ['Acme-PC1','Acme-PC2']) admin.emit('remove_client', id);
  admin.emit('admin_delete_user', { username: c1.username });  // deletes whole org
  admin.emit('admin_delete_user', { username: c2.username });
  await wait(400);
  [own1.s, own2.s, tm1.s, newTry.s, admin].forEach(s => { try { s.disconnect(); } catch (_) {} });

  const fails = R.filter(x => !x).length;
  console.log(`\n${R.length - fails}/${R.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('E2E error:', e.message, e.stack); process.exit(1); });
