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
- `server-deploy/` — signaling server (Node/Express/socket.io) + dashboard.
  - `server.js` — auth, agent registry, WebRTC relay, per-platform update feeds + rollout.
  - `dashboard/` — support web UI (`index.html`, `script.js`, `style.css`, `download.html`).
- `deploy-release.ps1` — release script (uploads feeds to the EC2 server). **ASCII-only** (PowerShell 5.1 misreads BOM-less UTF-8).
- `.github/workflows/build-mac-agent.yml` — builds the macOS DMG/ZIP (needs a Mac runner).

## Infra (do not rediscover — see memory `deployment-setup`)

- Live server: AWS EC2 London `52.56.155.181`, systemd unit `techsara`, app at `/opt/techsara`, data in `/opt/techsara/data` (persists across deploys).
- Public HTTPS via CloudFront `https://d14bkbpwfdn5ch.cloudfront.net` (secure context is required for `getDisplayMedia`). CloudFront caching is disabled.
- Deploy: `ssh -i ~/.ssh/techsara-london ec2-user@52.56.155.181`, then `deploy-release.ps1`.
- Discovery: client fetches the signaling URL from S3 (primary) / npoint (fallback) / last-known.

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
- Server/socket tests run against a scratch copy: copy `server-deploy/` to a temp
  dir, junction `node_modules`, stage fake feeds, and
  `PORT=<p> ADMIN_USERNAME=tester ADMIN_PASSWORD=test1234 node server.js`.
- Current client version: **1.4.0** (`client/package.json`).

## Conventions

- Bump `client/package.json` version for any client change that ships.
- `deploy-release.ps1` stays ASCII-only.
- Dashboard renderer and client renderer are hand-written vanilla JS/HTML/CSS —
  no build step, no framework.
