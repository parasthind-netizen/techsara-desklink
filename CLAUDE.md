# DeskLink — remote support platform (CLAUDE.md)

Consent-based remote-assistance product by Techsara Solutions. A support agent
issues a one-time installation code; the customer installs the **DeskLink**
desktop app (Windows + macOS), enters the code, and their machine appears on
the support **dashboard**. Support then views/controls the screen over WebRTC.
The customer always sees a visible app + tray/menu-bar icon, an on-screen
"X is viewing your screen" banner, and a **Disable Support Access** button; an
uninstaller is provided. Keep that visibility and consent model intact — do not
make the agent covert, undetectable, or impossible to remove.

## Layout

- `client/` — Electron agent (the app installed on customer machines).
  - `main.js` — Electron main: capture handler, auto-update, watchdog wiring, nut-js input, macOS permission IPC.
  - `index.html` — the single renderer (UI + socket.io client + WebRTC + install-code flow + macOS permission banner). All renderer JS is one inline `<script>`.
  - `remote-input.js` — dashboard→OS input mapping (DPI/multi-monitor; macOS uses points, Windows uses `dipToScreenRect`).
  - `watchdog.js` — cross-platform keep-alive (Windows Scheduled Task + named pipes; macOS LaunchAgent + Unix sockets).
  - `preload.js` — contextBridge IPC surface.
  - `build/` — electron-builder assets: `icon.png` (1024px), `installer.nsh`, `entitlements.mac.plist`.
  - `BUILD-MAC.md` — how to build/sign/ship the macOS agent.
- `server-deploy/` — signaling server (Node/Express/socket.io) + everything the browser loads.
  - `server.js` — auth (customers, teams, session tokens), agent registry, live-session bookkeeping, WebRTC relay, per-platform update feeds + rollout, static file serving (gzip + ETag) and security headers.
  - `dashboard/` — the whole site, served at the root path:
    - `landing.html` + `landing.js` — public marketing page at `/`.
    - `download.html` + `download.js` — the page support staff send to the person at the computer.
    - `index.html` + `script.js` + `style.css` — the console at `/dashboard` (sign-in page + app shell: sidebar, Overview, Agents, Live session, Install Agent, Activity, Team, My Account, Owner Console).
    - `theme.js` — light / dark / system theme (`data-theme` on `<html>`, `localStorage dl_theme`); loaded in `<head>` so there is no flash.
    - `fonts/` — self-hosted Inter + JetBrains Mono (woff2) and `fonts.css`. `favicon.svg`.
- `tests/` — automated tests + the scratch-server scripts (see `tests/README.md`).
- `deploy-release.ps1` — release script (`-ServerOnly` for server + dashboard without a client release). **ASCII-only** (PowerShell 5.1 misreads BOM-less UTF-8).
- `.github/workflows/build-mac-agent.yml` — builds the macOS DMG/ZIP (needs a Mac runner).

## Infra (do not rediscover — see memory `deployment-setup`)

- Live server: AWS EC2 London `52.56.155.181`, systemd unit `techsara`, app at `/opt/techsara`, data in `/opt/techsara/data` (persists across deploys).
- Public HTTPS via CloudFront `https://d14bkbpwfdn5ch.cloudfront.net` (secure context is required for `getDisplayMedia`). CloudFront caching is disabled.
- Deploy: `.\deploy-release.ps1 -ServerOnly` (server + dashboard) or `.\deploy-release.ps1` (also the client update feeds). SSH (`ssh -i ~/.ssh/techsara-london ec2-user@52.56.155.181`) only works from the office IP allow-listed in the security group. Each deploy keeps `server.js.prev` and `dashboard.prev` on the server for a one-step rollback (commands are in the script header).
- Discovery: client fetches the signaling URL from S3 (primary) / npoint (fallback) / last-known.
- URLs: landing `/`, console `/dashboard`, download page `/download.html`, installers `/download/windows-zip` · `/download/windows` · `/download/mac[?arch=intel]`, `/api/downloads` (which installers exist), `/healthz`.

## Key invariants — don't break these

- **Availability is persistent and only changes by an explicit human action** —
  the in-app Enable/Disable button OR a dashboard enable/disable
  (`set_agent_availability`). Closing the app, a Task-Manager/Activity-Monitor
  kill, a reboot, a session ending, or a reconnect must NEVER change it. The
  **server is authoritative**: it persists the flag in `agents.json` and pushes
  it to the client via `availability_state` on every register, so a dashboard
  toggle sticks across client restarts. The client adopts that value and does
  not self-assert its old flag on reconnect (there's a 2.5s fallback only for
  servers too old to send `availability_state`).
- **Watchdog keeps the agent alive** on unattended desks: a second
  `DeskLink --watchdog` process relaunches the app within ~2s if it's killed,
  and a logon task/LaunchAgent starts it after login/reboot. The app sends a
  `quit` message to the watchdog before a deliberate exit (tray "Exit
  Completely") or an update install, so it doesn't fight those.
- **Fresh install comes up Active** (agents ≥1.3.2): entering a valid code is
  the consent step, so the machine shows online+available immediately — no
  extra click. Older (≤1.2.x) agents start disabled by design.
- **Register is gated + authenticated**: unknown agent name → rejected; a
  pending slot requires its install code; a bound ≥1.3.0 agent requires its
  per-machine `secret`. 1.2.0 agents are grandfathered (no secret). Keep the
  socket `register` contract backward-compatible forever.
- **Updates are per-platform**: Windows reads `latest.yml`, macOS reads
  `latest-mac.yml`. `updateAvailable`, canary health, push targets, rollback and
  `allowDowngrade` are all computed against the client's OWN platform feed. A
  healthy mac canary must not unlock pushing an untested Windows build, and
  vice versa.
- **Never upload `.blockmap` files** to the feed (CloudFront can't serve
  byteranges; clients disable differential downloads). Installer artifact names
  are **versioned** (`DeskLink-Setup-<ver>.exe`) — constant names collide in the
  updater cache.
- **Tenants are isolated.** A customer (`TS-000N`) is an organization; its team
  members share its machines and nobody else's. Only the product owner
  (`admin` role) sees everything. Every socket handler that names a machine
  must check `canSeeAgent`; every owner-only handler must check `requireAdmin`.
  A machine's `tenantId` is stored on its `agents.json` entry and must survive
  every re-register; removing a team member hands their machines to the
  organization's owner account. Customer IDs are never reused.
- **The site ships no third-party code and no inline scripts.** `server.js`
  sends a strict Content-Security-Policy (`script-src 'self'`): every script,
  style, font and image must be a file under `dashboard/`, and page behaviour
  goes in a `.js` file, never in an inline `<script>` or `on…=` attribute.
  Names typed by people are untrusted: the server strips markup (`cleanName`)
  and the console escapes them (`esc()`) before any `innerHTML`.
- **The console never keeps the password.** Sign-in returns a signed 24h
  session token (bound to the account's password hash AND a per-account
  `sessionGen` that bumps on every password sign-in and on Log out, so a reset,
  delete, newer sign-in or logout kills it; suspension is re-checked on use)
  that the tab keeps in `sessionStorage` for silent re-login on reconnect/reload.
  The typed password is cleared from the DOM once signed in. Failed sign-ins are
  throttled per viewer+account, but a correct password is never locked out (the
  per-account ceiling only refuses wrong passwords). The viewer address is the
  validated last `X-Forwarded-For` hop; set `TRUSTED_ORIGIN_SECRET` (and have
  CloudFront send `x-origin-secret`) to stop a direct-to-origin caller forging
  it. Install codes (`register`) are throttled and expire after 7 days.
- **WebRTC signalling is authorized, not a blind relay** (`relayPeer` in
  `server.js`). `offer`/`answer`/`ice-candidate` are forwarded only between the
  two parties of a live session, each only in its own direction (machine→its
  console: offer/ice; console→its machine: answer/ice). A socket in no session,
  a forged/non-string `target`, or an oversized blob is dropped — so no one can
  inject or snoop on another session. The console ignores an unsolicited `offer`
  (no `targetClientId`) and closes the previous peer before accepting a new one.
- **Data files fail closed.** `loadJSON` returns the empty fallback ONLY for a
  missing file (ENOENT); a permission/parse/wrong-type error makes the server
  refuse to start rather than treat real data as empty and overwrite it (an
  empty `agents.json` would tell the whole fleet to de-provision). `saveJSON`
  writes+fsyncs a temp file, keeps a `.bak`, then renames. Never auto-load the
  `.bak`.
- **HTTP errors never leak internals.** `NODE_ENV`-independent (`app.set('env',
  'production')`) plus a 404 handler and a 4-arg error handler that send only
  status text — no stack, no file path. No body parser is mounted (every route
  is a bodyless GET).
- **Live sessions clean up after themselves** (`server.js`, "holds"):
  - One console per login — a second password sign-in signs the older console
    out with a message; a token re-register on a new socket carries the live
    session across.
  - If a console drops mid-session the machine stops sharing at once and the
    session is *held* for `SUPPORT_GRACE_MS` (2 min) so a reload or blip
    resumes it; then the machine is released. If the machine drops, the
    session is held for `CLIENT_GRACE_MS` (10 min, covers a reboot).
  - While held, teammates cannot take the machine; nobody but the holder or
    the product owner can end it. `endSession()` always drops the holds, so an
    ended session is never "restored" later. Connecting to another machine
    ends the console's previous session.
  - `inSession(clientId)` is the only test for "busy" — never
    `activeSessions.has()` alone.
  - A machine whose session ended while it was offline is told to stop (and drop
    the "is viewing" banner) on its next register (`strandedMachines`), and a
    `support_request` is paced at least `SUPPORT_REQUEST_GAP_MS` (3.5s, env) past
    any `session_ended` to that machine so the client's repaint timer can't hide
    the banner mid-share.

## macOS specifics

- `@nut-tree-fork/libnut-darwin` prebuilds are already in the lockfile — remote
  input works on macOS; use `Key.LeftCmd/RightCmd` for Meta, and map input in
  **points** (no Retina scaleFactor).
- TCC permissions (**Screen Recording** + **Accessibility**) are user-granted;
  the in-app banner guides them. Screen Recording needs an app restart to take
  effect (banner offers "Restart DeskLink").
- The app must live in **/Applications** — running from the DMG or a
  Gatekeeper-translocated path breaks auto-start; the banner tells the user to
  move it, and the watchdog refuses to pin a LaunchAgent to an unstable path.
- **Unsigned mac apps can't auto-update** (Squirrel.Mac validates signatures) —
  they install fine (right-click → Open) but only update by reinstall. Signing
  needs an Apple Developer ID + notarization (see `BUILD-MAC.md`).

## Build / test

- Windows installer: `cd client && npm install && npx electron-builder --win nsis`
  (set `CSC_IDENTITY_AUTO_DISCOVERY=false`). Output in `client/dist/`.
- macOS installer: run the **Build macOS agent** GitHub Actions workflow (Macs
  only), then drop the artifact into `client/dist/`. See `BUILD-MAC.md`.
- **Tests: `.\tests\run-all.ps1`** (add `-SkipUi` for the fast server-only
  pass; `-Port <n> -Name <s>` to run a second copy alongside). ~360 checks. It
  starts throw-away scratch servers on `:3998` — never the live one — and runs
  the socket-level suites, a browser click-through of the real pages, and
  `ui-session.js` (a real WebRTC screen-share with input) in off-screen
  Chromium. Run it before every deploy. To work on the
  console by hand: `.\tests\scratch-server.ps1 -Seed -NoMac`, then open
  `http://127.0.0.1:3998`. Details and gotchas in `tests/README.md`.
- Current client version: **1.4.1** (`client/package.json`). The macOS
  installer has not been built yet (the public pages show "Coming soon" for Mac
  until a mac feed is staged — driven by `/api/downloads`, no code change
  needed when it ships).

## Console UI

- `style.css` is a small design system: every colour is a token on `:root`
  with a `[data-theme="dark"]` override, so a new component must use tokens
  (`var(--surface)`, `var(--text-2)`, `var(--primary)`…) to work in both themes.
- Feedback goes through `toast()`; confirmations and prompts through
  `uiConfirm()` / `uiPrompt()` (promise-based) — never `alert/confirm/prompt`.
  Destructive confirmations use `tone: 'danger'`.
- Views are `#view-<id>` sections switched by `openTab(id)` / `showView(id)`;
  `allowedView()` keeps `admin` to the product owner and `team` to a customer's
  main account. The server enforces the same rules.
- The WebRTC / remote-input pipeline in `script.js` is independent of the
  shell — restyling must not touch it.

## Conventions

- Bump `client/package.json` version for any client change that ships.
- Every `.ps1` in the repo stays ASCII-only.
- Dashboard renderer and client renderer are hand-written vanilla JS/HTML/CSS —
  no build step, no framework.
