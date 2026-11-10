#!/bin/bash
# DeskLink macOS uninstaller — removes the app, its watchdog LaunchAgent and
# all per-user data. Run as the user who installed it (no sudo needed):
#   bash uninstall-mac.sh
set -u

LABEL="com.techsara.desklink.watchdog"
UID_NUM="$(id -u)"

echo "== DeskLink uninstaller =="

# 1. Unload the watchdog FIRST (or it would relaunch the app mid-uninstall).
echo "[1/4] Removing the watchdog LaunchAgent..."
launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/${LABEL}.plist"

# 2. Stop the app (watchdog is already gone, so nothing brings it back).
echo "[2/4] Stopping DeskLink..."
pkill -x DeskLink 2>/dev/null || true
sleep 1
pkill -9 -x DeskLink 2>/dev/null || true

# 3. Remove the app bundle.
echo "[3/4] Removing the app..."
rm -rf "/Applications/DeskLink.app" "$HOME/Applications/DeskLink.app"

# 4. Remove per-user data (identity, update cache, preferences).
echo "[4/4] Removing app data..."
rm -rf "$HOME/Library/Application Support/DeskLink" \
       "$HOME/Library/Application Support/Caches/desklink-updater" \
       "$HOME/Library/Caches/com.techsara.remoteclient" \
       "$HOME/Library/Caches/com.techsara.remoteclient.ShipIt" \
       "$HOME/Library/Preferences/com.techsara.remoteclient.plist" \
       "$HOME/Library/Saved Application State/com.techsara.remoteclient.savedState"
rm -rf "${TMPDIR:-/tmp}"/desklink-* 2>/dev/null || true

echo ""
echo "Done. DeskLink has been removed from this Mac."
echo "(Privacy permissions for DeskLink can be tidied up in System Settings"
echo " -> Privacy & Security -> Screen Recording / Accessibility.)"
