// Production E2E for the always-active guarantees + dashboard toggle +
// per-platform rollout. Server on :3998. Uses realistic 1.4.0 agents with the
// per-machine secret handshake.
const { io } = require(require('path').join(__dirname, '..', 'client', 'node_modules', 'socket.io-client'));
const URL = process.env.DL_TEST_URL || 'http://127.0.0.1:3998';
const R = [];
const check = (n, c) => { R.push({ n, c: !!c }); console.log((c ? 'PASS ' : 'FAIL ') + n); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
function once(s, ev, t = 4000) {
  return new Promise((res, rej) => { const h = setTimeout(() => rej(new Error('timeout ' + ev)), t); s.once(ev, d => { clearTimeout(h); res(d); }); });
}
const conn = async () => { const s = io(URL, { transports: ['websocket'] }); await once(s, 'connect'); return s; };

(async () => {
  const admin = await conn();
  admin.emit('register', { type: 'support', username: 'tester', password: 'test1234' });
  await once(admin, 'login_success');
  const mkSlot = async (name) => { admin.emit('create_agent_slot', { name }); const d = await once(admin, 'agent_slot_created'); return d.code.replace(/\D/g, ''); };
  // Bind a fresh 1.4.0 agent, returning its socket + issued secret.
  const install = async (name, platform) => {
    const code = await mkSlot(name);
    const s = await conn();
    const boundP = once(s, 'client_bound');
    const avP = once(s, 'availability_state');
    s.emit('register', { type: 'client', clientId: name, appVersion: '1.4.0', platform, installCode: code });
    const secret = (await boundP).secret;
    const av = await avP;
    return { s, secret, av };
  };

  // ════ C) AUTO-LIVE ON INSTALL ════
  const macA = await install('Prod MacA', 'darwin');
  check('C: fresh 1.4.0 install comes up Available (no click)', macA.av.available === true);
  let list = await new Promise(res => { admin.once('clients_list', res); macA.s.emit('set_availability', { available: true }); });
  let m = list.find(c => c.id === 'Prod MacA');
  check('C: shows online+available on dashboard right after install', m && m.online && m.available === true);
  check('C: dashboard tags it as a mac agent', m && m.platform === 'mac');

  // ════ A) SURVIVE KILL/CLOSE/REBOOT ════
  const kt = await install('Prod KillTest', 'win32');
  check('A: installed agent is Active', kt.av.available === true);
  // Simulate Task-Manager kill + watchdog relaunch: drop the socket, reconnect
  // with the saved secret, send NO set_availability (new client waits for the
  // server's authoritative value).
  kt.s.disconnect(); await wait(200);
  const kt2 = await conn();
  const kt2av = once(kt2, 'availability_state');
  kt2.emit('register', { type: 'client', clientId: 'Prod KillTest', appVersion: '1.4.0', platform: 'win32', secret: kt.secret });
  const kt2v = await kt2av;
  check('A: after kill+relaunch the agent is STILL Active (no re-click)', kt2v.available === true);
  list = await new Promise(res => { admin.once('clients_list', res); kt2.emit('set_availability', { available: true }); });
  check('A: dashboard shows it back online+available', (m = list.find(c => c.id === 'Prod KillTest')) && m.online && m.available);

  // ════ B + DASHBOARD) DISABLE ONLY BY EXPLICIT ACTION ════
  const wa = await install('Prod WinA', 'win32');
  check('B: new win agent Active on install', wa.av.available === true);
  // Session-end / disconnect must NOT change availability (incidental events).
  // Simulate a disconnect+reconnect (not a disable) — stays available.
  wa.s.disconnect(); await wait(200);
  const wa2 = await conn();
  const wa2av = once(wa2, 'availability_state');
  wa2.emit('register', { type: 'client', clientId: 'Prod WinA', appVersion: '1.4.0', platform: 'win32', secret: wa.secret });
  check('B: incidental reconnect keeps it Active', (await wa2av).available === true);

  // Dashboard disables the ONLINE agent.
  const waDis = once(wa2, 'availability_state');
  admin.emit('set_agent_availability', { clientId: 'Prod WinA', available: false });
  const okDis = await once(admin, 'agent_availability_ok');
  check('Dash: disable acked', okDis.available === false);
  check('Dash: online client told to go Inactive', (await waDis).available === false);
  list = await new Promise(res => { admin.once('clients_list', res); admin.emit('set_agent_availability', { clientId: 'Prod WinA', available: false }); });
  check('Dash: dashboard shows Unavailable after disable', (m = list.find(c => c.id === 'Prod WinA')) && m.available === false);

  // The key test: dashboard disable STICKS across a client restart.
  wa2.disconnect(); await wait(200);
  const wa3 = await conn();
  const wa3av = once(wa3, 'availability_state');
  wa3.emit('register', { type: 'client', clientId: 'Prod WinA', appVersion: '1.4.0', platform: 'win32', secret: wa.secret });
  check('Dash: disable STICKS after client restart', (await wa3av).available === false);

  // Re-enable from dashboard reaches the client.
  const waEn = once(wa3, 'availability_state');
  admin.emit('set_agent_availability', { clientId: 'Prod WinA', available: true });
  await once(admin, 'agent_availability_ok');
  check('Dash: re-enable reaches the client', (await waEn).available === true);

  // Ownership guard.
  admin.emit('admin_create_user', { username: 'other', password: 'pw123456', role: 'support' });
  await Promise.race([once(admin, 'admin_ok'), once(admin, 'admin_error')]).catch(() => {});  // may already exist
  const other = await conn();
  other.emit('register', { type: 'support', username: 'other', password: 'pw123456' });
  await once(other, 'login_success');
  other.emit('set_agent_availability', { clientId: 'Prod WinA', available: false });
  check('Guard: non-owner cannot toggle another user\'s agent', /not yours/i.test(await once(other, 'agent_availability_error')));
  other.disconnect();

  // Pending slot cannot be toggled.
  await mkSlot('Prod Pending');
  admin.emit('set_agent_availability', { clientId: 'Prod Pending', available: true });
  check('Guard: pending agent cannot be toggled', /not completed/i.test(await once(admin, 'agent_availability_error')));

  // ════ PER-PLATFORM ROLLOUT ════
  const mb = await install('Prod MacB', 'darwin');   // comes up on 1.4.0 == mac feed, so re-register as outdated
  mb.s.disconnect(); await wait(150);
  const mbOld = await conn();
  mbOld.emit('register', { type: 'client', clientId: 'Prod MacB', appVersion: '1.3.5', platform: 'darwin', secret: mb.secret });
  await once(mbOld, 'availability_state');
  await wait(150);

  admin.emit('admin_push_update_all');
  check('Rollout: push_all locked with no canary', /canary/i.test(await once(admin, 'admin_error')));

  const macCheck = once(mbOld, 'check_update');
  admin.emit('admin_push_update_one', 'Prod MacB');
  await once(admin, 'admin_ok');
  await macCheck;
  const canaryEv = once(admin, 'canary_healthy');
  mbOld.disconnect(); await wait(150);
  const mbNew = await conn();
  mbNew.emit('register', { type: 'client', clientId: 'Prod MacB', appVersion: '1.4.0', platform: 'darwin', secret: mb.secret });
  check('Rollout: mac canary healthy reports platform=mac', (await canaryEv).platform === 'mac');

  // WinA (now 1.4.0, but win feed is 1.3.9 so it's a downgrade target → not outdated).
  // Use KillTest which is 1.4.0 vs win feed 1.3.9 — also not "outdated" (newer).
  // So add an outdated win agent to prove the gate.
  const wc = await install('Prod WinC', 'win32');
  wc.s.disconnect(); await wait(150);
  const wcOld = await conn();
  wcOld.emit('register', { type: 'client', clientId: 'Prod WinC', appVersion: '1.3.0', platform: 'win32', secret: wc.secret });
  await once(wcOld, 'availability_state');
  let wcPushed = false; wcOld.on('check_update', () => { wcPushed = true; });
  await wait(150);
  admin.emit('admin_push_update_all');
  const okAll = await once(admin, 'admin_ok');
  await wait(400);
  check('Rollout: healthy MAC canary does NOT push outdated WINDOWS agent', wcPushed === false && /Windows/i.test(okAll));

  admin.emit('admin_feed_info');
  const feed = await once(admin, 'admin_feed');
  check('Rollout: feed shows mac canary healthy + win not', feed.canaryHealthyMac === true && feed.canaryHealthyWin === false);
  check('Rollout: feed shows both active versions', feed.active === '1.3.9' && feed.activeMac === '1.4.0');

  // cleanup
  for (const id of ['Prod MacA','Prod KillTest','Prod WinA','Prod Pending','Prod MacB','Prod WinC'])
    admin.emit('remove_client', id);
  await wait(400);
  admin.disconnect();

  const fails = R.filter(r => !r.c).length;
  console.log(`\n${R.length - fails}/${R.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('E2E error:', e.message, e.stack); process.exit(1); });
