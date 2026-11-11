// Unit tests for client/watchdog.js: the Windows pipe protocol and the macOS
// LaunchAgent plist / stable-path logic (the mac parts are pure and run on any OS).
//
// The pipe-protocol part uses the REAL per-user pipe names, so it only runs
// when DeskLink is not running for this user — otherwise it would talk to the
// real app and its watchdog. In that case those checks are skipped.
const path = require('path');
const net = require('net');
const wd = require(path.join(__dirname, '..', 'client', 'watchdog.js'));
const results = [];
const check = (n, c) => { results.push(c); console.log((c ? 'PASS ' : 'FAIL ') + n); };

const probe = (pipe) => new Promise((resolve) => {
  const s = net.connect(pipe);
  s.setTimeout(800, () => { s.destroy(); resolve(false); });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

(async () => {
  check('pipe names are per-user', /desklink-main-/.test(wd.MAIN_PIPE) && /desklink-watchdog-/.test(wd.WATCHDOG_PIPE));

  const appRunning = (await probe(wd.MAIN_PIPE)) || (await probe(wd.WATCHDOG_PIPE));
  if (appRunning) {
    console.log('SKIP pipe-protocol checks: DeskLink is running for this user on this machine');
  } else {
    const srv = await wd.startMainPipe();
    check('startMainPipe listens', !!srv);
    check('main pipe probes alive', await probe(wd.MAIN_PIPE));
    const srv2 = await wd.startMainPipe(2);
    check('second listen on a held pipe returns null (single instance)', srv2 === null);
    srv.close();
    await new Promise(r => setTimeout(r, 200));
    check('main pipe probes dead after close', !(await probe(wd.MAIN_PIPE)));
    // stopWatchdog with no watchdog running must resolve quickly, not hang
    const t0 = Date.now();
    await wd.stopWatchdog();
    check('stopWatchdog resolves fast with no watchdog', Date.now() - t0 < 2500);
  }

  // ── macOS plist generation (pure, platform-independent) ──
  const plist = wd.agentPlistContent('/Applications/DeskLink.app/Contents/MacOS/DeskLink');
  check('plist has label', plist.includes('<string>com.techsara.desklink.watchdog</string>'));
  check('plist runs the binary with --watchdog',
        plist.includes('<string>/Applications/DeskLink.app/Contents/MacOS/DeskLink</string>') &&
        plist.includes('<string>--watchdog</string>'));
  check('plist RunAtLoad + KeepAlive on unsuccessful exit only',
        plist.includes('<key>RunAtLoad</key><true/>') &&
        plist.includes('<key>SuccessfulExit</key><false/>'));
  check('plist limited to Aqua session', plist.includes('<string>Aqua</string>'));
  const esc = wd.agentPlistContent('/Users/a&b/My <App>/DeskLink');
  check('plist XML-escapes the path', esc.includes('/Users/a&amp;b/My &lt;App&gt;/DeskLink') && !esc.includes('a&b'));
  check('AGENT_LABEL exported', wd.AGENT_LABEL === 'com.techsara.desklink.watchdog');

  // ── macOS stable-path guard (translocation / DMG detection) ──
  const S = wd.macPathShapeIsStable;
  check('path: /Applications app is stable', S('/Applications/DeskLink.app/Contents/MacOS/DeskLink') === true);
  check('path: ~/Applications app is stable', S('/Users/joe/Applications/DeskLink.app/Contents/MacOS/DeskLink') === true);
  check('path: DMG mount (/Volumes) is NOT stable', S('/Volumes/DeskLink 1.4.0/DeskLink.app/Contents/MacOS/DeskLink') === false);
  check('path: AppTranslocation is NOT stable', S('/private/var/folders/xy/AppTranslocation/ABC/d/DeskLink.app/Contents/MacOS/DeskLink') === false);
  check('path: /private/var/folders is NOT stable', S('/private/var/folders/xy/zz/T/DeskLink.app/Contents/MacOS/DeskLink') === false);
  check('path: empty is NOT stable', S('') === false);
  if (process.platform !== 'darwin')
    check('isStableMacExecPath is always true off macOS', wd.isStableMacExecPath('/Volumes/x/DeskLink') === true);

  const fails = results.filter(r => !r).length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('test error:', e); process.exit(1); });
