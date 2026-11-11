// Branding E2E: owner sets app name -> connected agent gets it live + /branding
// endpoint + new agent receives it on register. Server on :3998.
const http = require('http');
const { io } = require(require('path').join(__dirname, '..', 'client', 'node_modules', 'socket.io-client'));
const URL = process.env.DL_TEST_URL || 'http://127.0.0.1:3998';
const R = []; const check = (n, c) => { R.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n); };
function once(s, ev, t = 4000) { return new Promise((res, rej) => { const h = setTimeout(() => rej(new Error('timeout ' + ev)), t); s.once(ev, d => { clearTimeout(h); res(d); }); }); }
const conn = async () => { const s = io(URL, { transports: ['websocket'] }); await once(s, 'connect'); return s; };
const get = (p) => new Promise((res) => http.get(URL + p, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (_) { res(null); } }); }).on('error', () => res(null)));

(async () => {
  const admin = await conn();
  admin.emit('register', { type: 'support', username: 'paras', password: 'ownerpass123' });
  await once(admin, 'login_success');

  // default brand
  admin.emit('admin_get_brand');
  const b0 = await once(admin, 'admin_brand');
  check('default brand is DeskLink', b0.name === 'DeskLink');
  const ep0 = await get('/branding');
  check('/branding returns default', ep0 && ep0.name === 'DeskLink');

  // register an agent (needs a pending slot first)
  admin.emit('create_agent_slot', { name: 'BrandPC' });
  const slot = await once(admin, 'agent_slot_created');
  const code = slot.code.replace(/\D/g, '');
  const agent = await conn();
  const brandOnRegister = once(agent, 'branding');
  agent.emit('register', { type: 'client', clientId: 'BrandPC', appVersion: '1.4.1', platform: 'win32', installCode: code });
  const br = await brandOnRegister;
  check('agent receives brand on register', br.name === 'DeskLink');

  // owner changes the brand -> connected agent gets it live
  const liveBrand = once(agent, 'branding');
  admin.emit('admin_set_brand', { name: 'Acme Assist' });
  const ok = await once(admin, 'admin_ok');
  check('set_brand acked (pushed to online agents)', /Acme Assist/.test(ok) && /1 online/.test(ok));
  const live = await liveBrand;
  check('connected agent received new brand live', live.name === 'Acme Assist');

  // persisted: /branding and admin_get_brand reflect it
  const ep1 = await get('/branding');
  check('/branding reflects new brand', ep1 && ep1.name === 'Acme Assist');
  admin.emit('admin_get_brand');
  const b1 = await once(admin, 'admin_brand');
  check('admin_get_brand reflects new brand', b1.name === 'Acme Assist');

  // a NEW agent connecting gets the new brand on register
  admin.emit('create_agent_slot', { name: 'BrandPC2' });
  const slot2 = await once(admin, 'agent_slot_created');
  const agent2 = await conn();
  const br2 = once(agent2, 'branding');
  agent2.emit('register', { type: 'client', clientId: 'BrandPC2', appVersion: '1.4.1', platform: 'win32', installCode: slot2.code.replace(/\D/g, '') });
  check('new agent gets current brand on register', (await br2).name === 'Acme Assist');

  // guard: non-owner cannot set brand
  // (reset brand back to DeskLink for cleanliness)
  admin.emit('admin_set_brand', { name: 'DeskLink' });
  await once(admin, 'admin_ok');

  // cleanup
  admin.emit('remove_client', 'BrandPC'); admin.emit('remove_client', 'BrandPC2');
  await new Promise(r => setTimeout(r, 300));
  [agent, agent2, admin].forEach(s => { try { s.disconnect(); } catch (_) {} });
  const fails = R.filter(x => !x).length;
  console.log(`\n${R.length - fails}/${R.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('E2E error:', e.message); process.exit(1); });
