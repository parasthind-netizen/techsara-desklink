// Seeds the scratch server with realistic demo data and KEEPS fake agents online
// (until killed) so the console can be screenshotted in a lived-in state.
const { io } = require(require('path').join(__dirname, '..', 'client', 'node_modules', 'socket.io-client'));
const fs = require('fs');
const URL = process.env.DL_TEST_URL || 'http://127.0.0.1:3998';
const OUT = process.argv[2];
const once = (s, ev, t = 6000) => new Promise((res, rej) => { const h = setTimeout(() => rej(new Error('timeout ' + ev)), t); s.once(ev, d => { clearTimeout(h); res(d); }); });
const conn = async () => { const s = io(URL, { transports: ['websocket'] }); await once(s, 'connect'); return s; };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const keep = [];

async function supportLogin(u, p) {
  const s = await conn();
  s.emit('register', { type: 'support', username: u, password: p });
  await once(s, 'login_success');
  return s;
}
async function slot(sup, name) {
  sup.emit('create_agent_slot', { name });
  const d = await once(sup, 'agent_slot_created');
  return d.code.replace(/\D/g, '');
}
async function fakeAgent(name, code, platform, version) {
  const s = await conn();
  const bound = once(s, 'client_bound').catch(() => null);
  s.emit('register', { type: 'client', clientId: name, appVersion: version, platform, installCode: code });
  await bound;
  keep.push(s);
  return s;
}

(async () => {
  const admin = await supportLogin('paras', 'ownerpass123');
  const mkCustomer = async (displayName, teamLimit) => {
    admin.emit('admin_create_customer', { displayName, teamLimit });
    return once(admin, 'customer_created');
  };
  const acme   = await mkCustomer('Acme Retail', 5);
  const globex = await mkCustomer('Globex Corporation', 3);
  const initech = await mkCustomer('Initech Systems', 0);

  // ── Acme: five machines in every state + two team members ──
  const a = await supportLogin(acme.username, acme.password);
  const c1 = await slot(a, 'Reception-PC');
  const c2 = await slot(a, 'Accounts-MacBook');
  const c3 = await slot(a, 'Warehouse-01');
  const c4 = await slot(a, 'Store-Backup');
  await slot(a, 'Front-Desk-2');                               // stays "To install"
  await fakeAgent('Reception-PC', c1, 'win32', '1.4.1');         // available
  await fakeAgent('Accounts-MacBook', c2, 'darwin', '1.4.0');    // available (mac)
  const w = await fakeAgent('Warehouse-01', c3, 'win32', '1.3.9');  // online, outdated
  w.emit('set_availability', { available: false });             // access off
  const sb = await fakeAgent('Store-Backup', c4, 'win32', '1.4.1');
  await wait(200); sb.disconnect();                              // offline
  for (const n of ['Priya Sharma', 'Rahul Verma']) {
    a.emit('team_create', { displayName: n });
    await once(a, 'team_member_created');
  }

  // ── Globex: one mac, one windows ──
  const g = await supportLogin(globex.username, globex.password);
  await fakeAgent('Globex-Design-iMac', await slot(g, 'Globex-Design-iMac'), 'darwin', '1.4.0');
  await fakeAgent('Globex-Laptop-07',  await slot(g, 'Globex-Laptop-07'),  'win32',  '1.4.1');

  // ── Initech: suspended, nothing installed ──
  admin.emit('admin_suspend_user', { username: initech.username, suspended: true });
  await once(admin, 'admin_ok');

  fs.writeFileSync(OUT, JSON.stringify({ acme, globex, initech }, null, 2));
  console.log('SEEDED');
  [admin, a, g].forEach(s => s.disconnect());
  setInterval(() => {}, 1 << 30);   // stay alive: the fake agents remain online
})().catch(e => { console.error('SEED ERROR', e.message); process.exit(1); });
