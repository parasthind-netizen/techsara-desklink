// Team-member limit E2E: owner sets a limit at creation, customer can't exceed
// it, owner can raise it. Server on :3998.
const { io } = require(require('path').join(__dirname, '..', 'client', 'node_modules', 'socket.io-client'));
const URL = process.env.DL_TEST_URL || 'http://127.0.0.1:3998';
const R = []; const check = (n, c) => { R.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n); };
function once(s, ev, t = 4000) { return new Promise((res, rej) => { const h = setTimeout(() => rej(new Error('timeout ' + ev)), t); s.once(ev, d => { clearTimeout(h); res(d); }); }); }
const conn = async () => { const s = io(URL, { transports: ['websocket'] }); await once(s, 'connect'); return s; };
const login = async (u, p) => { const s = await conn(); const ok = once(s, 'login_success').then(d => ({ ok: d })).catch(() => null); const err = once(s, 'login_error').then(d => ({ err: d })).catch(() => null); s.emit('register', { type: 'support', username: u, password: p }); return { s, res: await Promise.race([ok, err]) }; };

(async () => {
  const admin = await conn();
  admin.emit('register', { type: 'support', username: 'paras', password: 'ownerpass123' });
  await once(admin, 'login_success');

  // create customer with a team limit of 2
  admin.emit('admin_create_customer', { displayName: 'Limited Co', teamLimit: 2 });
  const c = await once(admin, 'customer_created');
  const users = await once(admin, 'admin_users');
  const row = users.find(u => u.customerId === c.customerId);
  check('customer created with teamLimit=2', row && row.teamLimit === 2 && row.teamCount === 0);

  const own = await login(c.username, c.password);
  // create 2 team members (allowed)
  own.s.emit('team_create', { displayName: 'M1' }); await once(own.s, 'team_member_created');
  own.s.emit('team_create', { displayName: 'M2' }); await once(own.s, 'team_member_created');
  check('2 team members created within limit', true);

  // 3rd should be rejected
  own.s.emit('team_create', { displayName: 'M3' });
  const err = await once(own.s, 'team_error');
  check('3rd team member rejected at limit', /limit/i.test(err));

  // owner raises the limit to 3
  admin.emit('admin_set_team_limit', { username: c.username, teamLimit: 3 });
  await once(admin, 'admin_ok');
  // now the 3rd is allowed
  own.s.emit('team_create', { displayName: 'M3' });
  const m3 = await once(own.s, 'team_member_created');
  check('after raising limit, 3rd team member allowed', !!m3.username);

  // usage reflected to owner
  admin.emit('admin_list_users');
  const users2 = await once(admin, 'admin_users');
  const row2 = users2.find(u => u.customerId === c.customerId);
  check('owner sees 3/3 usage', row2 && row2.teamCount === 3 && row2.teamLimit === 3);

  // limit 0 blocks all team members
  admin.emit('admin_create_customer', { displayName: 'NoTeam Co', teamLimit: 0 });
  const c0 = await once(admin, 'customer_created');
  const own0 = await login(c0.username, c0.password);
  own0.s.emit('team_create', { displayName: 'Nope' });
  const err0 = await once(own0.s, 'team_error');
  check('limit 0 blocks all team members', /does not include|limit/i.test(err0));

  // cleanup
  admin.emit('admin_delete_user', { username: c.username });
  admin.emit('admin_delete_user', { username: c0.username });
  await new Promise(r => setTimeout(r, 300));
  [own.s, own0.s, admin].forEach(s => { try { s.disconnect(); } catch (_) {} });
  const fails = R.filter(x => !x).length;
  console.log(`\n${R.length - fails}/${R.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('E2E error:', e.message); process.exit(1); });
