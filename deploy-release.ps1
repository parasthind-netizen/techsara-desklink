# Deploy script. Run from: c:\Techsara Remote Project
#
#   .\deploy-release.ps1               full release: server + dashboard + client update feed(s)
#   .\deploy-release.ps1 -ServerOnly   server + dashboard only (no client release)
#
# RELEASE RULES (learned 2026-08-20, v1.3.5):
#  - artifactName is VERSIONED (DeskLink-Setup-<ver>.exe) - constant names
#    collide in the updater cache (EPERM rename, Defender holds old file).
#  - NEVER upload .blockmap files - CloudFront can't serve multipart/byteranges,
#    differential updates always fail; clients 1.3.5+ skip them anyway.
#  - downloads/ constant name is DeskLink-Setup.exe, auto-synced by server.js at boot.
# MAC (since v1.4.0): if client\dist\ holds latest-mac.yml + DeskLink-<ver>-*.zip/.dmg
# (built on a Mac or via the "Build macOS agent" GitHub Actions workflow - see
# client\BUILD-MAC.md), they are uploaded alongside the Windows feed. server.js
# serves latest-mac.yml to mac agents and syncs the DMG to /download/mac.
# NOTE: uploading the feed IS the release - every agent's hourly auto-check will
# take it within ~1h whether or not you push the canary. The canary gate only
# controls how FAST it reaches the fleet, not whether it does.
#
# DASHBOARD: the whole server-deploy\dashboard folder is uploaded (pages, scripts,
# styles, fonts) and swapped in as one unit. The previous server.js and dashboard
# are kept on the server as server.js.prev and dashboard.prev - to roll back:
#   sudo cp /opt/techsara/server.js.prev /opt/techsara/server.js
#   sudo rm -rf /opt/techsara/dashboard; sudo cp -r /opt/techsara/dashboard.prev /opt/techsara/dashboard
#   sudo systemctl restart techsara
# The site sends a strict Content-Security-Policy: no inline <script>, and every
# script, style and font must be served from the dashboard folder itself.
#
# This file must stay ASCII-only (PowerShell 5.1 misreads BOM-less UTF-8).
param([switch]$ServerOnly)

$ErrorActionPreference = "Stop"
$key = "$env:USERPROFILE\.ssh\techsara-london"
$hostAddr = "ec2-user@52.56.155.181"
$stage = "/tmp/desklink-deploy"
$site = "https://d14bkbpwfdn5ch.cloudfront.net"

$ver = (Get-Content client\package.json | ConvertFrom-Json).version
$exe = "client\dist\DeskLink-Setup-$ver.exe"
$macYml = "client\dist\latest-mac.yml"
$haveWin = (-not $ServerOnly) -and (Test-Path $exe)
$haveMac = (-not $ServerOnly) -and (Test-Path $macYml)
if (-not $ServerOnly) {
    if (-not $haveWin -and -not $haveMac) { throw "No installers found for v$ver (run electron-builder first; mac artifacts come from the GitHub Actions workflow). Use -ServerOnly to deploy just the server and dashboard." }
    if (-not $haveWin) { Write-Host "NOTE: no Windows installer for $ver - mac-only release" -ForegroundColor Yellow }
    if (-not $haveMac) { Write-Host "NOTE: no mac artifacts in client\dist - Windows-only release" -ForegroundColor Yellow }
    Write-Host "Releasing v$ver (win=$haveWin mac=$haveMac)" -ForegroundColor Cyan
} else {
    Write-Host "Deploying server + dashboard only (no client release)" -ForegroundColor Cyan
}

# Catch a broken file before it reaches the server.
node --check "server-deploy\server.js"
if ($LASTEXITCODE -ne 0) { throw "server.js does not parse - not deploying" }
Get-ChildItem "server-deploy\dashboard\*.js" | ForEach-Object {
    node --check $_.FullName
    if ($LASTEXITCODE -ne 0) { throw "$($_.Name) does not parse - not deploying" }
}

Write-Host "1/5 Staging files on server..."
ssh -i $key $hostAddr "rm -rf $stage; mkdir -p $stage/updates"

Write-Host "2/5 Uploading server + dashboard..."
scp -i $key "server-deploy\server.js" "${hostAddr}:$stage/"
scp -r -i $key "server-deploy\dashboard" "${hostAddr}:$stage/"

Write-Host "3/5 Uploading client update feed(s)..."
if ($haveWin) {
    Write-Host "    Windows v$ver (80 MB - takes a few minutes)..."
    scp -i $key "client\dist\latest.yml" $exe "${hostAddr}:$stage/updates/"
}
if ($haveMac) {
    Write-Host "    macOS v$ver (zips + dmgs - takes a few minutes)..."
    $macFiles = @($macYml)
    $macFiles += (Get-ChildItem "client\dist\DeskLink-$ver-*.zip" | ForEach-Object { $_.FullName })
    $macFiles += (Get-ChildItem "client\dist\DeskLink-$ver-*.dmg" | ForEach-Object { $_.FullName })
    scp -i $key $macFiles "${hostAddr}:$stage/updates/"
}
if (-not $haveWin -and -not $haveMac) { Write-Host "    (none - server only)" }

Write-Host "4/5 Installing + restarting techsara..."
ssh -i $key $hostAddr @"
set -e
test -f $stage/server.js
test -f $stage/dashboard/index.html
test -f $stage/dashboard/script.js
test -f $stage/dashboard/landing.html
test -f $stage/dashboard/landing.js
test -f $stage/dashboard/download.html
test -f $stage/dashboard/fonts/fonts.css
sudo cp /opt/techsara/server.js /opt/techsara/server.js.prev
sudo rm -rf /opt/techsara/dashboard.new /opt/techsara/dashboard.prev
sudo cp -r $stage/dashboard /opt/techsara/dashboard.new
sudo mv /opt/techsara/dashboard /opt/techsara/dashboard.prev
sudo mv /opt/techsara/dashboard.new /opt/techsara/dashboard
sudo cp $stage/server.js /opt/techsara/server.js
if ls $stage/updates/* >/dev/null 2>&1; then sudo cp $stage/updates/* /opt/techsara/updates/; fi
# downloads/ sync not needed - server.js auto-syncs the feed exe to downloads/DeskLink-Setup.exe
# and the feed dmg to downloads/DeskLink.dmg at boot
sudo systemctl restart techsara
sleep 3
sudo systemctl is-active techsara
sudo journalctl -u techsara -n 12 --no-pager
rm -rf $stage
"@

Write-Host "5/5 Verifying via CloudFront..."
Start-Sleep -Seconds 2
foreach ($p in "/healthz", "/", "/dashboard", "/download.html", "/style.css", "/script.js", "/theme.js", "/fonts/fonts.css", "/fonts/inter-latin.woff2", "/favicon.svg", "/socket.io/socket.io.min.js", "/api/downloads") {
    $code = (Invoke-WebRequest -UseBasicParsing "$site$p").StatusCode
    Write-Host ("    {0,-32} {1}" -f $p, $code)
}
if ($haveWin) { (Invoke-WebRequest -UseBasicParsing "$site/updates/latest.yml").Content.Split("`n")[0] }
if ($haveMac) { (Invoke-WebRequest -UseBasicParsing "$site/updates/latest-mac.yml").Content.Split("`n")[0] }

Write-Host ""
if ($ServerOnly) {
    Write-Host "DONE. Server and dashboard are live at $site"
} else {
    Write-Host "DONE. Now log in to the console as the product owner -> Owner Console -> Agents & releases:"
    Write-Host "push the update to ONE canary agent per platform (a mac canary only validates the mac feed),"
    Write-Host "wait for 'canary healthy', then 'Push update to all'. (Or wait ~1h for agents' hourly auto-check.)"
}
