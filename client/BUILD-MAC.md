# DeskLink macOS agent — build, release & lifecycle

The client code is cross-platform since v1.4.0. This file covers everything
macOS-specific: how to build the installer, how the agent lives on a Mac
(install → login persistence → watchdog → auto-update → uninstall), and what
code signing changes.

## How the macOS lifecycle works (what's in the code)

| Stage | Windows | macOS |
|---|---|---|
| Install | NSIS one-click `DeskLink-Setup-<ver>.exe` | DMG — drag DeskLink to Applications |
| First run | installation code screen | same, **plus** a permissions banner (Screen Recording + Accessibility) |
| Start at login | Scheduled Task "DeskLink Watchdog" (AtLogOn) | LaunchAgent `com.techsara.desklink.watchdog` (RunAtLoad) |
| Kill-protection | watchdog probes a named pipe, relaunches in ~2s; Task Scheduler guards the watchdog | same watchdog over a Unix socket in `$TMPDIR/desklink-<user>/`; **launchd** guards the watchdog (`KeepAlive={SuccessfulExit:false}`) |
| Exit Completely / update swap | app sends `quit` to the watchdog pipe | same — watchdog exits 0, which launchd deliberately does not restart |
| Auto-update | NSIS silent swap from `/updates/latest.yml` | Squirrel.Mac swap from `/updates/latest-mac.yml` (ZIP target; needs a signed app — see below) |
| Uninstall | NSIS uninstaller (removes the task via `installer.nsh`) | `uninstall-mac.sh` (bootout LaunchAgent, remove app + data) |

macOS permissions (TCC), surfaced by the in-app banner until granted:

- **Screen Recording** — without it the capture produces wallpaper-only frames.
  Granting it only takes effect after an app restart; the banner offers a
  "Restart DeskLink" button once it flips to granted.
- **Accessibility** — without it nut-js mouse/keyboard calls are silent no-ops.

## Building the installer

Mac targets can only be built on macOS. Two options:

**A. GitHub Actions (no Mac needed)** — push this project (including
`client/` and `.github/workflows/build-mac-agent.yml`) to the GitHub repo,
run the **Build macOS agent** workflow from the Actions tab, download the
`desklink-mac-<version>` artifact and unzip it into `client/dist/` on the
office machine.

**B. On any Mac:**

```bash
cd client
npm ci
npm run build:mac        # dist/: DeskLink-<ver>-{arm64,x64}.{dmg,zip} + latest-mac.yml
```

Both arches are built: `arm64` (Apple Silicon) and `x64` (Intel).
electron-updater picks the right ZIP from `latest-mac.yml` by matching
`process.arch` in the filename — keep the arch in the artifact name.

## Code signing & notarization (required for auto-update)

- **Unsigned builds work for manual installs** — the user right-clicks the app
  → Open (or System Settings → Privacy & Security → "Open Anyway" on newer
  macOS), same situation as the unsigned Windows exe.
- **Auto-update does NOT work unsigned on macOS.** Squirrel.Mac validates the
  running app's code signature; electron-updater fails with "could not get
  code signature" on unsigned apps. The anti-brick fail cap in main.js stops
  it from retrying forever, but unsigned Mac agents only update by
  reinstalling the DMG.
- To sign + notarize: get an Apple Developer ID Application certificate
  (Apple Developer Program, $99/yr), then either set the CI secrets listed in
  `build-mac-agent.yml`, or on a Mac export `CSC_LINK`/`CSC_KEY_PASSWORD` and
  `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` and build with
  `npx electron-builder --mac --arm64 --x64 -c.mac.notarize=true`.
  Hardened runtime + entitlements (`build/entitlements.mac.plist`) are already
  configured.

## Releasing to the fleet

Same pipeline as Windows — `deploy-release.ps1` picks up mac artifacts
automatically when they are present in `client/dist/`:

1. Put `latest-mac.yml`, the two `.zip`s and the two `.dmg`s in `client/dist/`
   (same version as `client/package.json`).
2. Run `deploy-release.ps1`. It uploads them to `/opt/techsara/updates/` next
   to the Windows feed. The server then:
   - serves `/updates/latest-mac.yml` (no-store) to mac agents' electron-updater;
   - syncs the newest DMG to `/download/mac` (customer-facing `DeskLink.dmg`);
   - archives the mac feed per version for rollback (same admin panel flow).
3. Dashboard → Admin Panel: push to ONE mac canary, wait for "canary healthy",
   then Push to ALL — identical to Windows. The server compares each agent's
   version against **its own platform's** staged feed, so mixed fleets are fine.
   NEVER upload `.blockmap` files (CloudFront can't serve byteranges; clients
   disable differential downloads anyway).

## Uninstalling from a Mac

Send the customer `uninstall-mac.sh` (or run it over a session):

```bash
bash uninstall-mac.sh
```

It unloads the LaunchAgent first (so nothing relaunches the app), stops the
app, and removes the bundle plus all per-user data. Manual equivalent:
`launchctl bootout gui/$(id -u)/com.techsara.desklink.watchdog`, delete
`~/Library/LaunchAgents/com.techsara.desklink.watchdog.plist`, delete
`/Applications/DeskLink.app` and `~/Library/Application Support/DeskLink`.
