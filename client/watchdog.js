// Keeps DeskLink running on an unattended desk. Cross-platform: Windows and macOS.
//
// A second, windowless instance of this exe (`DeskLink --watchdog`) probes the
// app every WATCHDOG_INTERVAL_MS over a local IPC endpoint and relaunches it
// when the endpoint is gone — i.e. when someone ended it from Task Manager /
// Activity Monitor or it crashed.
//
// Windows: the endpoints are named pipes and the watchdog is started by a
// per-user Scheduled Task ("DeskLink Watchdog"), so its parent is the Task
// Scheduler service: "End task" on the DeskLink app group in Task Manager
// cannot take the watchdog down with it. The same task fires at logon, which
// is also what brings DeskLink up after a reboot. Registering the task needs
// no elevation (verified on Windows 11 as a standard, unelevated user).
//
// macOS: the endpoints are Unix domain sockets in the per-user temp dir and
// the watchdog is a launchd LaunchAgent (~/Library/LaunchAgents/
// com.techsara.desklink.watchdog.plist) with RunAtLoad (starts at login) and
// KeepAlive={SuccessfulExit:false}: launchd itself restarts the watchdog if it
// is force-quit, but leaves it alone when it exits 0 — which is exactly what
// it does on a deliberate "quit" (Exit Completely / update install), so
// launchd never fights either. Registering a LaunchAgent needs no admin.
//
// Protocol (per user):
//   <main endpoint>      app listens; a successful connect = alive
//   <watchdog endpoint>  watchdog listens; doubles as its own single-instance
//                        lock; the app sends "quit\n" here on Exit Completely
//                        and before an update installs.
//
// Limits: a user who can kill both processes can still stop DeskLink (and on
// macOS remove the LaunchAgent) — only a system service/daemon could prevent
// that, and DeskLink is a per-user app by design.

const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const SUPPORTED = IS_WIN || IS_MAC;

const TASK_NAME   = 'DeskLink Watchdog';                 // Windows Scheduled Task
const AGENT_LABEL = 'com.techsara.desklink.watchdog';    // macOS LaunchAgent label
const WATCHDOG_INTERVAL_MS = 2000;   // probe cadence → relaunch within ~2-3 s
const RELAUNCH_GRACE_MS    = 8000;   // let a fresh instance bring its endpoint up before probing again

function userTag() {
  let u = 'user';
  try { u = os.userInfo().username; } catch (_) {}
  return String(u).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
}

// IPC endpoints. Windows named pipes are per-user by tag; on macOS os.tmpdir()
// is already per-user (/var/folders/…) but the tag keeps Linux safe too.
// Unix socket paths must stay under ~104 chars — these are well inside that.
let MAIN_PIPE, WATCHDOG_PIPE, SOCK_DIR = null;
if (IS_WIN) {
  MAIN_PIPE     = `\\\\.\\pipe\\desklink-main-${userTag()}`;
  WATCHDOG_PIPE = `\\\\.\\pipe\\desklink-watchdog-${userTag()}`;
} else {
  SOCK_DIR      = path.join(os.tmpdir(), `desklink-${userTag()}`);
  MAIN_PIPE     = path.join(SOCK_DIR, 'main.sock');
  WATCHDOG_PIPE = path.join(SOCK_DIR, 'watchdog.sock');
}

// Try to connect to an endpoint; resolves true if something is listening.
function probe(pipe, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = net.connect(pipe);
    const done = (ok) => { try { sock.destroy(); } catch (_) {} resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

// Fire-and-forget one line to an endpoint server. Resolves when written or failed.
function send(pipe, line, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = net.connect(pipe);
    const done = () => { try { sock.destroy(); } catch (_) {} resolve(); };
    sock.setTimeout(timeoutMs, done);
    sock.once('error', done);
    sock.once('connect', () => sock.write(line + '\n', done));
  });
}

// Listen on an endpoint. Resolves the server, or null if the name is already
// taken (another live instance holds it) or IPC is unavailable.
// Unix sockets leave a stale file behind after a crash, which makes listen()
// fail EADDRINUSE with nobody actually listening — detect that (probe fails),
// unlink the corpse and retry once.
function listen(pipe, onLine) {
  if (!IS_WIN) { try { fs.mkdirSync(path.dirname(pipe), { recursive: true }); } catch (_) {} }
  return new Promise((resolve) => {
    const tryListen = (retriedStale) => {
      const server = net.createServer((sock) => {
        let buf = '';
        sock.setEncoding('utf8');
        sock.on('data', (d) => {
          buf += d;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (line && onLine) onLine(line, sock);
          }
        });
        sock.on('error', () => {});
      });
      server.on('error', (err) => {
        if (!IS_WIN && !retriedStale && err && err.code === 'EADDRINUSE') {
          probe(pipe).then((alive) => {
            if (alive) return resolve(null);              // a real instance holds it
            try { fs.unlinkSync(pipe); } catch (_) {}     // stale socket file
            tryListen(true);
          });
          return;
        }
        resolve(null);
      });
      server.listen(pipe, () => resolve(server));
    };
    tryListen(false);
  });
}

function psExec(script) {
  return new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', script],
      { windowsHide: true, timeout: 30000 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || err || '') }));
  });
}

function schtasks(args) {
  return new Promise((resolve) => {
    execFile('schtasks.exe', args, { windowsHide: true, timeout: 15000 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || err || '') }));
  });
}

// (Re)create the per-user logon task that runs the watchdog. Idempotent. (Windows)
async function registerTask(exePath) {
  const ps = `
$u = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$a = New-ScheduledTaskAction -Execute '${exePath.replace(/'/g, "''")}' -Argument '--watchdog' -WorkingDirectory '${path.dirname(exePath).replace(/'/g, "''")}'
$t = New-ScheduledTaskTrigger -AtLogOn -User $u
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$p = New-ScheduledTaskPrincipal -UserId $u -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName '${TASK_NAME}' -Description 'Restarts DeskLink if it is closed or killed, and starts it at logon.' -Action $a -Trigger $t -Settings $s -Principal $p -Force | Out-Null
`;
  return psExec(ps);
}

// ── macOS LaunchAgent ─────────────────────────────────────────────────────

function lctl(args) {
  return new Promise((resolve) => {
    execFile('/bin/launchctl', args, { timeout: 15000 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || err || '') }));
  });
}

const xmlEscape = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function agentPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', AGENT_LABEL + '.plist');
}

function agentPlistContent(exePath) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(exePath)}</string>
    <string>--watchdog</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict>
</plist>
`;
}

// Is this a stable macOS exec path we can safely pin a LaunchAgent to? False
// when the app is running from a mounted DMG (/Volumes/…) or has been
// Gatekeeper path-randomized ("app translocation", under AppTranslocation/…) —
// in both cases the path vanishes when the volume unmounts or the app is
// moved, so a LaunchAgent pointing at it would be dead on next login. The fix
// the user needs is to move DeskLink to /Applications, which we surface in the
// permissions banner instead of silently pinning a doomed path.
// Pure path-shape test (no platform gate) so it's unit-testable anywhere.
function macPathShapeIsStable(exePath) {
  const p = String(exePath || '');
  if (!p) return false;
  if (p.startsWith('/Volumes/')) return false;              // running from the DMG
  if (p.includes('/AppTranslocation/')) return false;        // Gatekeeper translocation
  if (p.includes('/private/var/folders/')) return false;     // translocation lives here too
  return true;
}
function isStableMacExecPath(exePath) {
  if (process.platform !== 'darwin') return true;
  return macPathShapeIsStable(exePath);
}

// (Re)register + start the LaunchAgent. Idempotent; needs no admin. (macOS)
async function registerLaunchAgent(exePath, log = () => {}) {
  if (!isStableMacExecPath(exePath)) {
    log('Not registering watchdog — app is not in a stable location (move it to Applications)');
    return { ok: false, err: 'unstable app path (DMG/translocation)' };
  }
  const uid = process.getuid();
  const plist = agentPlistPath();
  const content = agentPlistContent(exePath);
  let changed = true;
  try { changed = fs.readFileSync(plist, 'utf8') !== content; } catch (_) {}
  if (changed) {
    // Path changed (or first install): unload whatever launchd has, then
    // rewrite. bootout failing just means it wasn't loaded — ignore.
    await lctl(['bootout', `gui/${uid}/${AGENT_LABEL}`]);
    try { fs.mkdirSync(path.dirname(plist), { recursive: true }); } catch (_) {}
    try { fs.writeFileSync(plist, content); }
    catch (e) { return { ok: false, err: 'plist write failed: ' + e.message }; }
  }
  // bootstrap errors if already loaded — harmless; kickstart then starts the
  // job if it is loaded but not currently running.
  const boot = await lctl(['bootstrap', `gui/${uid}`, plist]);
  const kick = await lctl(['kickstart', `gui/${uid}/${AGENT_LABEL}`]);
  if (!boot.ok && !kick.ok) return { ok: false, err: (kick.err || boot.err).trim() };
  return { ok: true };
}

// ── Called by the app ─────────────────────────────────────────────────────

// Announce liveness. Keep the returned server for the life of the process.
// Retries: if a previous instance is still exiting it may briefly hold the
// name. Coming up without this endpoint is worse than a slow start — the
// watchdog would read us as dead and relaunch us every few seconds — so the
// caller treats a null here as "do not start a watchdog at all".
async function startMainPipe(attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    const server = await listen(MAIN_PIPE, null);
    if (server) return server;
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  return null;
}

// Make sure a watchdog is alive: start the task/LaunchAgent (registering it
// first if needed). Safe to call on every launch — a live watchdog is left alone.
async function ensureWatchdog(exePath, log = () => {}) {
  if (!SUPPORTED) return;
  if (await probe(WATCHDOG_PIPE)) { log('Watchdog already running'); return; }

  if (IS_MAC) {
    const reg = await registerLaunchAgent(exePath, log);
    if (!reg.ok) log('Watchdog LaunchAgent failed: ' + reg.err);
    else log('Watchdog started (launchd)');
    return;
  }

  let run = await schtasks(['/run', '/tn', TASK_NAME]);
  if (!run.ok) {
    const reg = await registerTask(exePath);
    if (!reg.ok) { log('Watchdog task registration failed: ' + reg.err.trim()); return; }
    log('Watchdog task registered');
    run = await schtasks(['/run', '/tn', TASK_NAME]);
  }
  if (!run.ok) log('Watchdog task start failed: ' + run.err.trim());
  else log('Watchdog started');
}

// Tell the watchdog to exit — before the app quits on purpose (Exit
// Completely, update install), so it does not immediately bring us back.
// On macOS the watchdog exits 0, which KeepAlive={SuccessfulExit:false}
// deliberately does not restart.
async function stopWatchdog() {
  if (!SUPPORTED) return;
  await send(WATCHDOG_PIPE, 'quit');
}

// ── The watchdog process itself (`--watchdog`) ────────────────────────────
async function runWatchdog(exePath, log = () => {}) {
  const server = await listen(WATCHDOG_PIPE, (line) => {
    if (line === 'quit') { log('Watchdog told to quit'); process.exit(0); }
  });
  if (!server) { log('Another watchdog is running — exiting'); process.exit(0); }
  log(`Watchdog up, guarding ${exePath}`);

  let lastLaunch = 0;
  const tick = async () => {
    const alive = await probe(MAIN_PIPE);
    if (!alive && Date.now() - lastLaunch > RELAUNCH_GRACE_MS) {
      log('DeskLink not running — relaunching');
      lastLaunch = Date.now();
      try {
        // On macOS exePath is the binary inside DeskLink.app — spawning it
        // directly launches the full bundle, no `open -a` needed.
        spawn(exePath, [], { detached: true, stdio: 'ignore', cwd: path.dirname(exePath) }).unref();
      } catch (e) { log('Relaunch failed: ' + e.message); }
    }
    setTimeout(tick, WATCHDOG_INTERVAL_MS);
  };
  tick();
}

module.exports = {
  startMainPipe, ensureWatchdog, stopWatchdog, runWatchdog,
  TASK_NAME, AGENT_LABEL, MAIN_PIPE, WATCHDOG_PIPE, WATCHDOG_INTERVAL_MS,
  registerLaunchAgent, agentPlistPath, agentPlistContent, isStableMacExecPath, macPathShapeIsStable
};
