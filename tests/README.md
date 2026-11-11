# DeskLink tests

Everything here runs against a **throw-away copy of the server** on
`http://127.0.0.1:3998` (created under `%TEMP%\desklink-scratch`, with clean
data and fake update feeds). Nothing touches the live server or
`server-deploy\data`.

## Run everything

From the project root, in PowerShell:

```powershell
.\tests\run-all.ps1            # server suites + both browser suites (~8 min)
.\tests\run-all.ps1 -SkipUi    # server suites only (~1 min)
.\tests\run-all.ps1 -Port 4011 -Name a   # a second port / scratch folder (run two at once)
```

Requires `npm install` in `server-deploy` (the server) and in `client` (it
provides `socket.io-client` and the Electron browser the UI tests drive).
Run it before every deploy; the exit code is 1 if anything failed.

## What is covered

| Suite | What it proves |
|---|---|
| `unit-watchdog.js` | Keep-alive pipe protocol (skipped if DeskLink is running on this PC) and the macOS LaunchAgent / stable-path logic. |
| `e2e-sessions.js` | Security headers and private paths; session tokens (no password in the browser, reset/suspend invalidate them); sign-in throttle; machines stay with their organization; the live-session rules — hold with a grace period, no takeover of a teammate's session, sign-in elsewhere, switching machines, machine reboot. |
| `e2e-tenant.js` | Customers are isolated from each other; suspend / enable / reset password / delete. |
| `e2e-team.js` | Team logins share their organization's machines and nothing else. |
| `e2e-limit.js` | The per-customer team-member limit. |
| `e2e-brand.js` | Renaming the product reaches agents live and on next connect. |
| `e2e-availability-rollout.js` | Availability only changes by an explicit action (survives kill / restart / reconnect); dashboard on/off; per-platform update feeds and the canary gate. |
| `e2e-rollback.js` | Rolling one platform back does not affect the other. |
| `ui-e2e.js` | The real pages in off-screen Chromium: sign-in, every console screen and dialog for the product owner, a customer and a team member, themes, reload/resume, the public landing and download pages, phone widths — and no console errors or Content-Security-Policy violations anywhere. |
| `ui-session.js` | A real WebRTC screen-sharing session end to end: a simulated machine streams a picture to the console, and pointer mapping (centre/corners/zoom/narrow), clicks, right-click, wheel, drag (incl. released off-picture), keyboard routing, the toggles, quality, clipboard, reconnect, every way of ending a session — plus that a machine cannot push its screen to a console that did not connect to it, and that a held remote button is never left stuck. |

## Working on the console by hand

```powershell
.\tests\scratch-server.ps1 -Seed -NoMac   # then open http://127.0.0.1:3998
.\tests\scratch-server.ps1 -StopOnly      # when done
```

`-Seed` loads three demo customers, two team members and seven machines in
every state, and keeps the fake machines online. The owner login is
`paras` / `ownerpass123`; the customers' generated logins are written to
`%TEMP%\desklink-scratch\creds.json`.

Screenshots of every screen (light, dark, narrow, phone):

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
& client\node_modules\electron\dist\electron.exe tests\screenshots.js "$env:TEMP\desklink-scratch\shots" "$env:TEMP\desklink-scratch\creds.json"
```

## Notes for writing tests

- VS Code terminals set `ELECTRON_RUN_AS_NODE=1`, which makes `electron.exe`
  behave like plain Node — clear it first (the runner does).
- An Electron script that opens several windows in turn needs
  `app.on('window-all-closed', () => {})`, or the app quits after the first.
- Each server suite expects a fresh server (customer IDs start at `TS-0001`
  and are never reused), so the runner restarts it between suites.
- `SUPPORT_GRACE_MS` / `CLIENT_GRACE_MS` shorten the session-hold periods so
  the timeout paths can be tested in seconds.
