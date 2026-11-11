// A REAL remote session, end to end, in off-screen Chromium (Electron):
//   - window 1 is the console, signed in as a customer;
//   - window 2 plays the customer's machine: it registers with an installation
//     code and, when support connects, streams a synthetic 1280x720 "screen"
//     over a genuine WebRTC peer connection with the same signaling and
//     data-channel protocol as the desktop app (client/index.html).
// The test then drives the console with real mouse / keyboard input and checks
// what the machine receives: picture, pointer mapping, clicks, wheel, keyboard
// routing, the control toggles, quality, clipboard polling, reconnects, and
// every way a session can end.
//   electron ui-session.js <creds.json>
// Needs the scratch server on :3998 seeded by seed-demo.js (tests/run-all.ps1
// does that).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const CREDS = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const BASE = process.env.DL_TEST_URL || 'http://127.0.0.1:3998';
const MACHINE = 'Session-PC-' + process.pid;
const PIC = { w: 1280, h: 720 };

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.commandLine.appendSwitch('force-device-scale-factor', '1');
// Two peers on one host: plain host candidates, no mDNS obfuscation.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.setPath('userData', path.join(require('os').tmpdir(), 'desklink-scratch', 'electron-profile-session-' + (new URL(BASE).port || '80')));

const R = [];
const logs = [];
const check = (n, c) => { R.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n); return !!c; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const Q = JSON.stringify;

function makeWin(w, h, tag) {
  const win = new BrowserWindow({ width: w, height: h, show: false, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false } });
  win.webContents.setFrameRate(30);
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) logs.push(`[${tag}] ${message} (${String(source).replace(BASE, '')}:${line})`);
  });
  return win;
}
const js = (win, code) => win.webContents.executeJavaScript(code, true);
async function until(win, expr, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    let v = false;
    try { v = await js(win, `(function(){ try { return (${expr}); } catch (e) { return false; } })()`); } catch (_) {}
    if (v) return v;
    if (Date.now() > end) return false;
    await sleep(60);
  }
}
const text = (win, sel) => js(win, `(function(){ const e = document.querySelector(${Q(sel)}); return e ? e.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
const click = async (win, sel) => { const ok = await js(win, `(function(){ const e = document.querySelector(${Q(sel)}); if (!e) return false; e.click(); return true; })()`); await sleep(120); return ok; };
const fill = (win, sel, value) => js(win, `(function(){ const e = document.querySelector(${Q(sel)}); if (!e) return false; e.value = ${Q(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const cardSel = (name) => `(Array.from(document.querySelectorAll('#agents-grid .agent-card')).find(c => c.querySelector('.ac-name').textContent === ${Q(name)}))`;
const cardStatus = (win, name) => js(win, `(function(){ const c = ${cardSel(name)}; return c ? c.querySelector('.status-pill').textContent.trim() : null; })()`);
const view = (win) => js(win, `document.getElementById('app').dataset.view`);
const toast = (win, re, ms = 4000) => until(win, `Array.from(document.querySelectorAll('#toast-stack .toast')).some(t => ${re}.test(t.textContent))`, ms);

// ── real input, in CSS pixels of the console page ──
let zoom = 1;
const mouse = (win, type, x, y, extra) => win.webContents.sendInputEvent(Object.assign({ type, x: Math.round(x * zoom), y: Math.round(y * zoom) }, extra || {}));
const moveTo = async (win, x, y) => { mouse(win, 'mouseMove', x, y); await sleep(70); };
// A press carries the "button is down" flag, as a real mouse does — without it
// the browser reports buttons=0 on pointerdown and refuses pointer capture.
const held = (button) => ({ modifiers: [(button || 'left') + 'ButtonDown'] });
const press = (win, x, y, button) => mouse(win, 'mouseDown', x, y, Object.assign({ button: button || 'left', clickCount: 1 }, held(button)));
const release = (win, x, y, button) => mouse(win, 'mouseUp', x, y, { button: button || 'left', clickCount: 1 });
const dragTo = async (win, x, y, button) => { mouse(win, 'mouseMove', x, y, Object.assign({ button: button || 'left' }, held(button))); await sleep(70); };
const clickAt = async (win, x, y, button) => {
  await moveTo(win, x, y);
  press(win, x, y, button); await sleep(40);
  release(win, x, y, button); await sleep(90);
};
const keyTap = async (win, keyCode) => {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode }); await sleep(30);
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await sleep(80);
};
// Where a point of the remote picture (0..1) is painted, computed here
// independently of the console's own code: the <video> box, letterboxed.
async function picturePoint(win, nx, ny) {
  const r = await js(win, `(function(){ const b = document.getElementById('remote-video').getBoundingClientRect(); return { l: b.left, t: b.top, w: b.width, h: b.height }; })()`);
  const pa = PIC.w / PIC.h, ea = r.w / r.h;
  let pw, ph;
  if (pa > ea) { pw = r.w; ph = r.w / pa; } else { ph = r.h; pw = r.h * pa; }
  const left = r.l + (r.w - pw) / 2, top = r.t + (r.h - ph) / 2;
  return { x: left + nx * pw, y: top + ny * ph, box: r, pw, ph };
}

// ── the fake machine (runs inside window 2) ──
const MACHINE_JS = `
(function () {
  const m = window.__m = { msgs: [], events: [], shares: 0, clip: 'baseline text', clipRequests: 0, secret: null, available: null, supportId: null, connected: false };
  let pc = null, dc = null, stream = null, timer = null;
  const s = window.__s = io({ transports: ['websocket'] });
  function cleanup() {
    if (timer) { clearInterval(timer); timer = null; }
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    if (pc) { pc.close(); pc = null; }
    dc = null;
  }
  m.cleanup = cleanup;
  async function share(supportId) {
    cleanup();
    m.supportId = supportId; m.shares++;
    const canvas = document.createElement('canvas');
    canvas.width = ${PIC.w}; canvas.height = ${PIC.h};
    const ctx = canvas.getContext('2d');
    let n = 0;
    const draw = () => {
      n++;
      ctx.fillStyle = '#16213e'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#4f46e5'; ctx.fillRect((n * 7) % canvas.width, 320, 80, 80);   // something always moves
      ctx.fillStyle = '#fff'; ctx.font = '48px sans-serif'; ctx.fillText('FAKE SCREEN ' + n, 60, 120);
    };
    draw(); timer = setInterval(draw, 33);
    stream = canvas.captureStream(30);
    pc = new RTCPeerConnection({ iceServers: [] });
    pc.addTransceiver(stream.getVideoTracks()[0], { direction: 'sendonly', streams: [stream] });
    dc = pc.createDataChannel('input', { ordered: true });
    dc.onopen = () => { m.connected = true; };
    dc.onclose = () => { m.connected = false; };
    dc.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch (_) { return; }
      if (msg.type === 'clipboard_request') { m.clipRequests++; dc.send(JSON.stringify({ type: 'clipboard_content', text: m.clip })); }
      else m.msgs.push(msg);
    };
    pc.onicecandidate = (e) => { if (e.candidate) s.emit('ice-candidate', { target: supportId, candidate: e.candidate }); };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    s.emit('offer', { target: supportId, sdp: offer });
  }
  m.share = share;
  m.register = (payload) => s.emit('register', Object.assign({ type: 'client', clientId: ${Q(MACHINE)}, appVersion: '1.4.1', platform: 'win32' }, payload));
  s.on('client_bound', (d) => { m.secret = d.secret; });
  s.on('availability_state', (d) => { m.available = d.available; });
  s.on('register_rejected', (msg) => { m.events.push(['register_rejected', msg]); });
  s.on('support_request', (d) => { m.events.push(['support_request', d.agentName, !!d.restored]); share(d.supportId); });
  s.on('session_ended', (d) => { m.events.push(['session_ended', d && d.reason]); cleanup(); });
  s.on('agent_reconnecting', () => { m.events.push(['agent_reconnecting']); cleanup(); });
  s.on('answer', async (d) => { if (pc) try { await pc.setRemoteDescription(d.sdp); } catch (e) { m.events.push(['answer_error', e.message]); } });
  s.on('ice-candidate', async (d) => { if (pc) try { await pc.addIceCandidate(d.candidate); } catch (_) {} });
  m.take = () => { const out = m.msgs.slice(); m.msgs.length = 0; return out; };
  m.lastEvent = () => m.events[m.events.length - 1] || null;
})(); true`;

const take = (mwin) => js(mwin, `__m.take()`);
const playing = async (cwin) => {
  const a = await js(cwin, `document.getElementById('remote-video').currentTime`);
  await sleep(450);
  const b = await js(cwin, `document.getElementById('remote-video').currentTime`);
  return b > a;
};
const near = (a, b, tol) => Math.abs(a - b) <= (tol || 0.012);
// A real picture with the shape of the shared screen. (Its pixel size adapts to
// the link, so only the aspect ratio is fixed.)
const PICTURE = `(function(){ const v = document.getElementById('remote-video'); return v.videoWidth >= 320 && Math.abs(v.videoWidth / v.videoHeight - ${PIC.w} / ${PIC.h}) < 0.02; })()`;
const size = (win) => js(win, `document.getElementById('remote-video').videoWidth + 'x' + document.getElementById('remote-video').videoHeight`);

app.whenReady().then(async () => {
  // ═════════ set up: console signed in, a machine enrolled ═════════
  const cwin = makeWin(1440, 900, 'console');
  await cwin.loadURL(BASE + '/dashboard'); await sleep(700);
  await js(cwin, `window.DLTheme.set('light'); true`);
  await fill(cwin, '#admin-name', CREDS.acme.username); await fill(cwin, '#admin-password', CREDS.acme.password);
  await js(cwin, `document.getElementById('login-form').requestSubmit(); true`);
  await until(cwin, `getComputedStyle(document.getElementById('app')).display !== 'none'`);
  await click(cwin, '.nav-item[data-open="agents"]');
  await click(cwin, '#agents-add'); await fill(cwin, '#ca-name', MACHINE); await click(cwin, '#ca-create');
  const code = await until(cwin, `/^\\d{3}-\\d{3}-\\d{3}$/.test(document.getElementById('ca-code').textContent) && document.getElementById('ca-code').textContent`);
  await click(cwin, '#ca-done');
  check('setup: the console issues an installation code', !!code);

  const mwin = makeWin(900, 600, 'machine');
  await mwin.loadURL(BASE + '/download.html'); await sleep(500);
  await js(mwin, `new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/socket.io/socket.io.min.js'; s.onload = () => res(true); s.onerror = () => rej(new Error('socket.io client failed to load')); document.head.appendChild(s); })`);
  await js(mwin, MACHINE_JS);
  await until(mwin, `__s.connected`);
  await js(mwin, `__m.register({ installCode: ${Q(String(code).replace(/\D/g, ''))} }); true`);
  check('setup: the machine enrolls with the code and gets its secret', await until(mwin, `!!__m.secret && __m.available === true`));
  check('setup: it shows up Available on the console straight away', await until(cwin, `(${cardSel(MACHINE)}).querySelector('.status-pill').textContent.trim() === 'Available'`));

  // ═════════ 1. connect: real picture ═════════
  await js(cwin, `(${cardSel(MACHINE)}).querySelector('.ac-foot .btn').click(); true`);
  check('connect: the machine is asked to share, by name of the support person', await until(mwin, `__m.shares === 1`) && (await js(mwin, `__m.events[0]`))[1] === CREDS.acme.username);
  const arrived = await until(cwin, PICTURE, 12000);
  check('connect: the picture arrives with the shape of the remote screen (' + await size(cwin) + ')', arrived);
  check('connect: the video is playing (frames keep advancing)', await playing(cwin));
  check('connect: the "connecting" overlay is gone', await until(cwin, `getComputedStyle(document.getElementById('placeholder')).display === 'none'`));
  check('connect: the control channel opens', await until(mwin, `__m.connected`) && await until(cwin, `document.getElementById('remote-video').classList.contains('remote-cursor')`));
  check('connect: the chosen quality is sent as soon as the channel opens', await until(mwin, `__m.msgs.some(x => x.type === 'quality' && x.level === 'high')`));
  check('connect: the console shows the machine name and the session entry', (await text(cwin, '#session-client-name')) === MACHINE && await until(cwin, `getComputedStyle(document.getElementById('nav-session')).display !== 'none'`));
  const box = (await picturePoint(cwin, 0, 0)).box;
  check('layout: the picture area fills the space beside the session panel', box.w > 900 && box.h > 700 && box.l >= 244);
  await take(mwin);

  // ═════════ 2. pointer mapping (real mouse input) ═════════
  let mapOk = true; const seen = [];
  for (const [nx, ny] of [[0.5, 0.5], [0.25, 0.25], [0.9, 0.8], [0.02, 0.97]]) {
    const p = await picturePoint(cwin, nx, ny);
    await moveTo(cwin, p.x, p.y); await sleep(120);
    const got = (await take(mwin)).filter(x => x.type === 'mousemove').pop();
    seen.push(got ? [got.x.toFixed(3), got.y.toFixed(3)] : null);
    if (!got || !near(got.x, nx) || !near(got.y, ny)) mapOk = false;
  }
  check('mouse: pointer positions map to the right place on the remote screen ' + Q(seen), mapOk);
  let p = await picturePoint(cwin, 0.3, 0.6);
  await clickAt(cwin, p.x, p.y);
  let got = await take(mwin);
  const down = got.find(x => x.type === 'mousedown'), up = got.find(x => x.type === 'mouseup');
  check('mouse: a click arrives as press + release at that exact point', down && up && down.button === 'left' && near(down.x, 0.3) && near(down.y, 0.6) && near(up.x, 0.3) && got.indexOf(down) < got.indexOf(up));
  await clickAt(cwin, p.x, p.y, 'right');
  got = await take(mwin);
  check('mouse: right-click is sent as the right button', got.some(x => x.type === 'mousedown' && x.button === 'right') && got.some(x => x.type === 'mouseup' && x.button === 'right'));
  mouse(cwin, 'mouseWheel', p.x, p.y, { deltaX: 0, deltaY: -120, canScroll: true }); await sleep(200);
  got = await take(mwin);
  check('mouse: the wheel scrolls the remote screen', got.some(x => x.type === 'scroll' && Math.abs(x.deltaY) > 0));
  // a drag that leaves the picture keeps tracking along its edge, and still ends
  const a = await picturePoint(cwin, 0.5, 0.5);
  await moveTo(cwin, a.x, a.y); press(cwin, a.x, a.y); await sleep(60);
  await dragTo(cwin, a.x - 200, a.y); await dragTo(cwin, 120, 300);            // out over the session panel, button still held
  release(cwin, 120, 300); await sleep(150);
  got = await take(mwin);
  const trail = got.map(x => x.type + (x.x !== undefined ? '@' + x.x.toFixed(2) + ',' + x.y.toFixed(2) : ''));
  check('mouse: a drag released outside the picture still releases the remote button ' + Q(trail), got.some(x => x.type === 'mousedown') && got.some(x => x.type === 'mouseup'));
  const edge = got.filter(x => x.type === 'mousemove').pop();
  check('mouse: outside the picture the drag keeps tracking, clamped to the edge', edge && edge.x === 0 && edge.y >= 0 && edge.y <= 1);
  // the same, but the release is NOT delivered to the picture (pointer capture
  // lost) - the remote button must still be let go
  await moveTo(cwin, a.x, a.y);
  mouse(cwin, 'mouseDown', a.x, a.y, { button: 'left', clickCount: 1 }); await sleep(60);   // no "held" flag -> no capture
  mouse(cwin, 'mouseMove', 120, 300); await sleep(70);
  release(cwin, 120, 300); await sleep(150);
  got = await take(mwin);
  check('mouse: even when the release never reaches the picture, the remote button is released', got.some(x => x.type === 'mousedown') && got.some(x => x.type === 'mouseup') && (await js(cwin, `heldButtons.size`)) === 0);

  // ═════════ 3. keyboard routing ═════════
  p = await picturePoint(cwin, 0.5, 0.5);
  await moveTo(cwin, p.x, p.y);
  check('keyboard: the "Keyboard -> Remote" indicator shows while the pointer is over the screen', await until(cwin, `document.getElementById('kbd-pill').classList.contains('on')`, 2000));
  await keyTap(cwin, 'A');
  got = await take(mwin);
  check('keyboard: keys typed over the screen go to the remote machine', got.some(x => x.type === 'keydown' && x.code === 'KeyA') && got.some(x => x.type === 'keyup' && x.code === 'KeyA'));
  cwin.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Shift' }); await sleep(60);
  await moveTo(cwin, 120, 500);                                   // pointer leaves the screen with Shift held
  got = await take(mwin);
  check('keyboard: a modifier held when the pointer leaves is released remotely (no stuck keys)', got.some(x => x.type === 'keydown' && /^Shift/.test(x.code)) && got.some(x => x.type === 'keyup' && /^Shift/.test(x.code)));
  cwin.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Shift' }); await sleep(60);
  check('keyboard: the indicator turns off outside the screen', !(await js(cwin, `document.getElementById('kbd-pill').classList.contains('on')`)));
  await take(mwin);
  await keyTap(cwin, 'B');
  check('keyboard: keys typed outside the screen stay local', (await take(mwin)).filter(x => /^key/.test(x.type)).length === 0);

  // ═════════ 4. control toggles, quality, clipboard ═════════
  await click(cwin, '#ctrl-mouse');
  check('toggle: Mouse OFF is shown', (await text(cwin, '#ctrl-mouse-label')) === 'Mouse: OFF' && !(await js(cwin, `document.getElementById('remote-video').classList.contains('remote-cursor')`)));
  await take(mwin);
  await moveTo(cwin, p.x, p.y); await clickAt(cwin, p.x + 30, p.y + 20);
  check('toggle: with the mouse off nothing is sent', (await take(mwin)).filter(x => /^mouse/.test(x.type)).length === 0);
  await click(cwin, '#ctrl-mouse');
  await moveTo(cwin, p.x + 5, p.y + 5); await sleep(100);
  check('toggle: Mouse ON works again', (await text(cwin, '#ctrl-mouse-label')) === 'Mouse: ON' && (await take(mwin)).some(x => x.type === 'mousemove'));
  await click(cwin, '#ctrl-keyboard');
  await moveTo(cwin, p.x, p.y); await take(mwin); await keyTap(cwin, 'C');
  check('toggle: with the keyboard off, keys are not sent even over the screen', (await text(cwin, '#ctrl-keyboard-label')) === 'Keyboard: OFF' && (await take(mwin)).filter(x => /^key/.test(x.type)).length === 0);
  await click(cwin, '#ctrl-keyboard');
  await moveTo(cwin, p.x + 8, p.y + 8); await keyTap(cwin, 'D');
  check('toggle: Keyboard AUTO works again', (await take(mwin)).some(x => x.type === 'keydown' && x.code === 'KeyD'));
  await js(cwin, `(function(){ const s = document.getElementById('ctrl-quality'); s.value = 'low'; s.dispatchEvent(new Event('change', { bubbles: true })); })(); true`);
  check('quality: choosing Low tells the machine', await until(mwin, `__m.msgs.some(x => x.type === 'quality' && x.level === 'low')`, 3000));
  await js(cwin, `(function(){ const s = document.getElementById('ctrl-quality'); s.value = 'high'; s.dispatchEvent(new Event('change', { bubbles: true })); })(); true`);
  check('clipboard: the console polls the machine clipboard once a second', await until(mwin, `__m.clipRequests >= 2`, 4000));
  await js(mwin, `__m.clip = 'copied on the machine'; true`);
  check('clipboard: new text copied on the machine reaches the console', await until(cwin, `lastClientClip === 'copied on the machine'`, 4000));

  // a dialog over the session must get the keyboard
  await moveTo(cwin, p.x, p.y); await take(mwin);
  await js(cwin, `uiConfirm('Test dialog', 'Keys must stay here.'); true`); await sleep(150);
  await keyTap(cwin, 'E');
  check('keyboard: a dialog on top of the session keeps the keys local', (await take(mwin)).filter(x => /^key/.test(x.type)).length === 0);
  await js(cwin, `closeDialog(false); true`); await sleep(100);

  // ═════════ 5. zoom and a narrow window ═════════
  cwin.webContents.setZoomFactor(1.25); zoom = 1.25; await sleep(500);
  p = await picturePoint(cwin, 0.75, 0.4);
  await moveTo(cwin, p.x - 3, p.y - 3); await moveTo(cwin, p.x, p.y); await sleep(150);
  got = (await take(mwin)).filter(x => x.type === 'mousemove').pop();
  check('zoom: pointer mapping holds at 125% browser zoom ' + Q(got && [got.x.toFixed(3), got.y.toFixed(3)]), got && near(got.x, 0.75, 0.015) && near(got.y, 0.4, 0.015));
  cwin.webContents.setZoomFactor(1); zoom = 1; await sleep(300);
  cwin.setContentSize(1024, 640); await sleep(600);
  p = await picturePoint(cwin, 0.6, 0.3);
  await moveTo(cwin, p.x - 3, p.y - 3); await moveTo(cwin, p.x, p.y); await sleep(150);
  got = (await take(mwin)).filter(x => x.type === 'mousemove').pop();
  check('narrow: pointer mapping holds in a small window ' + Q(got && [got.x.toFixed(3), got.y.toFixed(3)]), got && near(got.x, 0.6, 0.015) && near(got.y, 0.3, 0.015));
  check('narrow: the session panel and the End session button stay reachable', await js(cwin, `(function(){ const b = document.getElementById('disconnect-btn').getBoundingClientRect(); return b.width > 0 && b.bottom <= window.innerHeight && b.left >= 0; })()`));
  cwin.setContentSize(1440, 900); await sleep(500);

  // ═════════ 6. reconnects ═════════
  await click(cwin, '#reconnect-btn');
  check('reconnect: the Reconnect button makes the machine share again', await until(mwin, `__m.shares === 2`, 5000));
  check('reconnect: the picture comes back', await until(cwin, PICTURE, 12000) && await playing(cwin));
  await until(mwin, `__m.connected`); await take(mwin);
  p = await picturePoint(cwin, 0.4, 0.4); await moveTo(cwin, p.x - 4, p.y); await moveTo(cwin, p.x, p.y); await sleep(120);
  check('reconnect: control works on the new connection', (await take(mwin)).some(x => x.type === 'mousemove'));

  // the machine restarts its capture on its own (display changed) - a fresh offer with no warning
  await js(mwin, `__m.share(__m.supportId); true`);
  check('re-share: a fresh offer from the same machine is accepted and the picture continues', await until(mwin, `__m.shares === 3 && __m.connected`, 8000) && await until(cwin, PICTURE, 12000) && await playing(cwin));
  await sleep(300); await take(mwin);
  await moveTo(cwin, p.x + 6, p.y + 6); await moveTo(cwin, p.x + 9, p.y + 9); await sleep(150);
  check('re-share: control follows to the newest connection', (await take(mwin)).some(x => x.type === 'mousemove'));
  check('re-share: the console is left with exactly one live connection', (await js(cwin, `peerConnection && peerConnection.connectionState`)) === 'connected');

  // the machine drops off the network and comes back (the app kept running)
  await js(mwin, `__m.cleanup(); __s.disconnect(); true`);
  check('machine offline: the console says it is reconnecting and keeps the session', await until(cwin, `/Reconnecting to /.test(document.getElementById('placeholder-text').textContent) && getComputedStyle(document.getElementById('placeholder')).display !== 'none'`, 5000) && (await view(cwin)) === 'session');
  await js(mwin, `__s.connect(); true`); await until(mwin, `__s.connected`);
  await js(mwin, `__m.register({ secret: __m.secret }); true`);
  check('machine back: it is asked to resume, flagged as a restore', await until(mwin, `(__m.lastEvent() || [])[0] === 'support_request' && __m.lastEvent()[2] === true`, 5000));
  check('machine back: the picture and control return', await until(cwin, PICTURE + ` && getComputedStyle(document.getElementById('placeholder')).display === 'none'`, 12000) && await playing(cwin));

  // ═════════ 7. every way a session ends ═════════
  await click(cwin, '#disconnect-btn');
  check('end: End session tells the machine', await until(mwin, `(__m.lastEvent() || [])[0] === 'session_ended' && __m.lastEvent()[1] === 'agent_ended'`, 4000));
  check('end: the console leaves the session view and drops the picture', (await view(cwin)) !== 'session' && (await js(cwin, `document.getElementById('remote-video').srcObject === null && peerConnection === null && targetClientId === null`)));
  await click(cwin, '.nav-item[data-open="agents"]');
  check('end: the machine is Available again', await until(cwin, `(${cardSel(MACHINE)}).querySelector('.status-pill').textContent.trim() === 'Available'`, 4000));

  // an offer nobody asked for must be ignored
  const sharesBefore = await js(mwin, `__m.shares`);
  await js(mwin, `__m.share(__m.supportId); true`); await sleep(1800);
  check('unsolicited: a machine cannot push its screen to a console that did not connect to it', (await js(cwin, `peerConnection === null && document.getElementById('remote-video').srcObject === null`)) && (await view(cwin)) !== 'session');
  await js(mwin, `__m.cleanup(); true`);
  check('unsolicited: (the machine did try)', (await js(mwin, `__m.shares`)) === sharesBefore + 1);

  // the person at the machine ends it
  await js(cwin, `(${cardSel(MACHINE)}).querySelector('.ac-foot .btn').click(); true`);
  await until(cwin, PICTURE, 12000);
  await js(mwin, `__m.cleanup(); __s.emit('client_disconnect'); true`);
  check('end: "Disconnect Session" on the machine closes the console session and says why', await until(cwin, `document.getElementById('app').dataset.view !== 'session'`, 4000) && await toast(cwin, '/person at the computer ended/'));

  // support access switched off from the console mid-session
  await click(cwin, '.nav-item[data-open="agents"]');
  await js(cwin, `(${cardSel(MACHINE)}).querySelector('.ac-foot .btn').click(); true`);
  await until(cwin, PICTURE, 12000);
  await click(cwin, '.nav-item[data-open="agents"]');
  await js(cwin, `(function(){ const c = ${cardSel(MACHINE)}; c.querySelector('.card-menu-btn').click(); })()`); await sleep(150);
  await js(cwin, `(function(){ const c = ${cardSel(MACHINE)}; Array.from(c.querySelectorAll('.card-menu button')).find(b => b.textContent.trim() === 'Turn support access off').click(); })()`); await sleep(200);
  check('disable: turning access off during a session asks first', await until(cwin, `getComputedStyle(document.getElementById('ui-dialog')).display !== 'none'`, 2500));
  await click(cwin, '#dlg-ok');
  check('disable: the session ends on the machine and it is told access is off', await until(mwin, `(__m.lastEvent() || [])[1] === 'disabled_by_support' && __m.available === false`, 4000));
  check('disable: the console shows it as Access off, with no session', await until(cwin, `(${cardSel(MACHINE)}).querySelector('.status-pill').textContent.trim() === 'Access off'`, 4000) && (await js(cwin, `targetClientId === null`)));

  // ═════════ nothing went wrong in either browser ═════════
  check('browser: no console errors or CSP violations in either window', logs.length === 0);
  logs.slice(0, 20).forEach(l => console.log('   ' + l));

  const fails = R.filter(x => !x).length;
  console.log(`\n${R.length - fails}/${R.length} passed`);
  app.exit(fails ? 1 : 0);
}).catch((e) => { console.error('SESSION E2E error:', e && e.stack || e); const fails = R.filter(x => !x).length; console.log(`\n(aborted) ${R.length - fails}/${R.length} passed before the error`); app.exit(1); });
