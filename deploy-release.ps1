# Deploy template (last used: v1.3.9). Run from: c:\Techsara Remote Project
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
$ErrorActionPreference = "Stop"
$key = "$env:USERPROFILE\.ssh\techsara-london"
$hostAddr = "ec2-user@52.56.155.181"
$stage = "/tmp/desklink-deploy"

$ver = (Get-Content client\package.json | ConvertFrom-Json).version
$exe = "client\dist\DeskLink-Setup-$ver.exe"
$haveWin = Test-Path $exe
$macYml = "client\dist\latest-mac.yml"
$haveMac = Test-Path $macYml
if (-not $haveWin -and -not $haveMac) { throw "No installers found for v$ver (run electron-builder first; mac artifacts come from the GitHub Actions workflow)" }
if (-not $haveWin) { Write-Host "NOTE: no Windows installer for $ver - mac-only release" -ForegroundColor Yellow }
if (-not $haveMac) { Write-Host "NOTE: no mac artifacts in client\dist - Windows-only release" -ForegroundColor Yellow }
Write-Host "Releasing v$ver (win=$haveWin mac=$haveMac)" -ForegroundColor Cyan

Write-Host "1/5 Staging files on server..."
ssh -i $key $hostAddr "rm -rf $stage; mkdir -p $stage/dashboard $stage/updates"

Write-Host "2/5 Uploading server + dashboard..."
scp -i $key "server-deploy\server.js" "${hostAddr}:$stage/"
scp -i $key "server-deploy\dashboard\index.html" "server-deploy\dashboard\script.js" "server-deploy\dashboard\style.css" "server-deploy\dashboard\download.html" "${hostAddr}:$stage/dashboard/"

Write-Host "3/5 Uploading client v$ver update feed(s)..."
if ($haveWin) {
    Write-Host "    Windows (80 MB - takes a few minutes)..."
    scp -i $key "client\dist\latest.yml" $exe "${hostAddr}:$stage/updates/"
}
if ($haveMac) {
    Write-Host "    macOS (zips + dmgs - takes a few minutes)..."
    $macFiles = @($macYml)
    $macFiles += (Get-ChildItem "client\dist\DeskLink-$ver-*.zip" | ForEach-Object { $_.FullName })
    $macFiles += (Get-ChildItem "client\dist\DeskLink-$ver-*.dmg" | ForEach-Object { $_.FullName })
    scp -i $key $macFiles "${hostAddr}:$stage/updates/"
}

Write-Host "4/5 Installing + restarting techsara..."
ssh -i $key $hostAddr @"
set -e
sudo cp $stage/server.js /opt/techsara/server.js
sudo cp $stage/dashboard/* /opt/techsara/dashboard/
sudo cp $stage/updates/* /opt/techsara/updates/
# downloads/ sync no longer needed - server.js auto-syncs the feed exe to downloads/DeskLink-Setup.exe
# and the feed dmg to downloads/DeskLink.dmg at boot
sudo systemctl restart techsara
sleep 3
sudo systemctl is-active techsara
sudo journalctl -u techsara -n 12 --no-pager
rm -rf $stage
"@

Write-Host "5/5 Verifying via CloudFront..."
Start-Sleep -Seconds 2
Invoke-WebRequest -UseBasicParsing "https://d14bkbpwfdn5ch.cloudfront.net/healthz" | Select-Object -ExpandProperty StatusCode
if ($haveWin) { (Invoke-WebRequest -UseBasicParsing "https://d14bkbpwfdn5ch.cloudfront.net/updates/latest.yml").Content.Split("`n")[0] }
if ($haveMac) { (Invoke-WebRequest -UseBasicParsing "https://d14bkbpwfdn5ch.cloudfront.net/updates/latest-mac.yml").Content.Split("`n")[0] }

Write-Host ""
Write-Host "DONE. Now log in to the dashboard as paras -> Admin Panel -> push update to ONE canary agent"
Write-Host "per platform (a mac canary only validates the mac feed), wait for 'canary healthy',"
Write-Host "then 'Push to ALL'. (Or wait ~1h for agents' hourly auto-check.)"
