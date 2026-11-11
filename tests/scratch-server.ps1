# Starts a throw-away copy of the server on http://127.0.0.1:3998 with clean
# data and freshly staged FAKE update feeds. Nothing here touches the live
# server or the real server-deploy\data folder.
#
#   .\tests\scratch-server.ps1                 start (owner login paras / ownerpass123)
#   .\tests\scratch-server.ps1 -Seed           also load demo customers, team members and live fake agents
#   .\tests\scratch-server.ps1 -NoMac          stage no mac feed (how production looks until a mac build ships)
#   .\tests\scratch-server.ps1 -StopOnly       stop it
#   .\tests\scratch-server.ps1 -Port 4011 -Name a   a second, independent scratch server
#                                              (own port, own folder %TEMP%\desklink-scratch-a)
#
# Only processes this script started are stopped: the server whose PID it
# recorded (and only if something node.exe still holds the port) and the seed
# script of the same scratch folder. Anything else on the port is an error.
#
# ASCII-only, like every .ps1 in this repo (PowerShell 5.1 misreads BOM-less UTF-8).
param(
  [string]$AdminUser = 'paras',
  [string]$AdminPass = 'ownerpass123',
  [string]$WinFeed = '1.4.1',
  [string]$MacFeed = '1.4.0',
  [string[]]$ArchiveWin = @(),
  [switch]$NoMac,
  [switch]$Seed,
  [switch]$StopOnly,
  [int]$SupportGraceMs = 0,
  [int]$ClientGraceMs = 0,
  [int]$Port = 3998,
  [string]$Name = ''
)
$ErrorActionPreference = 'Stop'
if ($Name -and ($Name -notmatch '^[A-Za-z0-9_-]{1,32}$')) { throw "-Name may only use letters, digits, '-' and '_'." }
$tests   = $PSScriptRoot
$proj    = Join-Path (Split-Path -Parent $tests) 'server-deploy'
$scratch = Join-Path $env:TEMP ('desklink-scratch' + $(if ($Name) { "-$Name" } else { '' }))
$srv     = Join-Path $scratch 'srv'
$pidFile = Join-Path $scratch 'server.pid'
$port    = $Port

function Stop-Scratch {
  # 1. the server this folder started (recorded PID), if it is still node.exe
  if (Test-Path $pidFile) {
    $old = 0
    try { $old = [int](Get-Content $pidFile -TotalCount 1) } catch {}
    if ($old -gt 0) {
      $pr = Get-Process -Id $old -ErrorAction SilentlyContinue
      if ($pr -and $pr.ProcessName -eq 'node') { try { Stop-Process -Id $old -Force -ErrorAction Stop } catch {} }
    }
    Remove-Item $pidFile -ErrorAction SilentlyContinue
  }
  # 2. a node.exe still listening on our port (e.g. started before PID files existed)
  $listen = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $listen) {
    $pr = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    if (-not $pr) { continue }
    if ($pr.ProcessName -ne 'node') { throw "Port $port is used by '$($pr.ProcessName)' (PID $($pr.Id)), not a scratch server - pick another -Port." }
    $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($pr.Id)" -ErrorAction SilentlyContinue).CommandLine
    if ("$cmd" -notmatch 'server\.js') { throw "Port $port is held by a node process that is not a scratch server (PID $($pr.Id)) - pick another -Port." }
    try { Stop-Process -Id $pr.Id -Force -ErrorAction Stop } catch {}
  }
  # 3. the seed script of THIS scratch folder only
  $mine = [regex]::Escape($scratch + '\')
  Get-CimInstance Win32_Process -Filter "name='node.exe'" |
    Where-Object { $_.CommandLine -match 'seed-demo\.js' -and $_.CommandLine -match $mine } |
    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
  Start-Sleep -Milliseconds 600
}

function Write-WinFeed([string]$dir, [string]$ver) {
  New-Item -ItemType Directory -Force $dir | Out-Null
  $exe = "DeskLink-Setup-$ver.exe"
  [IO.File]::WriteAllText((Join-Path $dir $exe), "exe-$ver")
  [IO.File]::WriteAllText((Join-Path $dir 'latest.yml'),
    "version: $ver`nfiles:`n  - url: $exe`n    sha512: w1`npath: $exe`nsha512: w1`n")
}
function Write-MacFeed([string]$dir, [string]$ver) {
  New-Item -ItemType Directory -Force $dir | Out-Null
  $names = @("DeskLink-$ver-arm64.zip", "DeskLink-$ver-x64.zip", "DeskLink-$ver-arm64.dmg", "DeskLink-$ver-x64.dmg")
  foreach ($n in $names) { [IO.File]::WriteAllText((Join-Path $dir $n), "mac-$n") }
  $yml = "version: $ver`nfiles:`n"
  $i = 1
  foreach ($n in $names) { $yml += "  - url: $n`n    sha512: a$i`n"; $i++ }
  $yml += "path: $($names[0])`nsha512: a1`n"
  [IO.File]::WriteAllText((Join-Path $dir 'latest-mac.yml'), $yml)
}

New-Item -ItemType Directory -Force $scratch | Out-Null
Stop-Scratch
if ($StopOnly) { Write-Output 'STOPPED'; return }

if (-not (Test-Path (Join-Path $proj 'node_modules'))) { throw "Run 'npm install' in server-deploy first." }
New-Item -ItemType Directory -Force $srv | Out-Null

# current code
Copy-Item (Join-Path $proj 'server.js') $srv -Force
Copy-Item (Join-Path $proj 'package.json') $srv -Force
$dash = Join-Path $srv 'dashboard'
if (Test-Path $dash) { Remove-Item $dash -Recurse -Force }
Copy-Item (Join-Path $proj 'dashboard') $dash -Recurse -Force
$nm = Join-Path $srv 'node_modules'
if (-not (Test-Path $nm)) { cmd /c mklink /J "$nm" "$(Join-Path $proj 'node_modules')" | Out-Null }

# clean state
foreach ($d in 'data', 'updates', 'downloads') {
  $p = Join-Path $srv $d
  if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}
$upd = Join-Path $srv 'updates'
Write-WinFeed $upd $WinFeed
if (-not $NoMac) { Write-MacFeed $upd $MacFeed }
foreach ($v in $ArchiveWin) { Write-WinFeed (Join-Path $upd "archive\$v") $v }

$env:PORT = "$port"
$env:ADMIN_USERNAME = $AdminUser
$env:ADMIN_PASSWORD = $AdminPass
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
if ($SupportGraceMs -gt 0) { $env:SUPPORT_GRACE_MS = "$SupportGraceMs" } else { Remove-Item Env:SUPPORT_GRACE_MS -ErrorAction SilentlyContinue }
if ($ClientGraceMs -gt 0) { $env:CLIENT_GRACE_MS = "$ClientGraceMs" } else { Remove-Item Env:CLIENT_GRACE_MS -ErrorAction SilentlyContinue }
$proc = Start-Process -FilePath node -ArgumentList 'server.js' -WorkingDirectory $srv `
  -RedirectStandardOutput (Join-Path $srv 'out.log') -RedirectStandardError (Join-Path $srv 'err.log') `
  -WindowStyle Hidden -PassThru
[IO.File]::WriteAllText($pidFile, "$($proc.Id)")

$up = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 300
  try { $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 2; if ($r.StatusCode -eq 200) { $up = $true; break } } catch {}
}
if (-not $up) { Write-Output 'SERVER FAILED TO START'; Get-Content (Join-Path $srv 'err.log') -Tail 20; exit 1 }
Write-Output "SERVER UP http://127.0.0.1:$port (owner=$AdminUser, win=$WinFeed, mac=$(if ($NoMac) { 'none' } else { $MacFeed }), dir=$scratch)"

if ($Seed) {
  $seedOut = Join-Path $scratch 'seed-out.log'
  $seedErr = Join-Path $scratch 'seed-err.log'
  $creds   = Join-Path $scratch 'creds.json'
  Remove-Item $seedOut, $seedErr, $creds -ErrorAction SilentlyContinue
  $env:DL_TEST_URL = "http://127.0.0.1:$port"
  Start-Process -FilePath node -ArgumentList "`"$(Join-Path $tests 'seed-demo.js')`"", "`"$creds`"" -WorkingDirectory $scratch `
    -RedirectStandardOutput $seedOut -RedirectStandardError $seedErr -WindowStyle Hidden | Out-Null
  $ok = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 400
    if ((Test-Path $seedOut) -and (Select-String -Path $seedOut -Pattern 'SEEDED' -Quiet)) { $ok = $true; break }
  }
  if ($ok) { Write-Output "SEEDED (demo logins in $creds)" } else { Write-Output 'SEED FAILED'; if (Test-Path $seedErr) { Get-Content $seedErr -Tail 20 }; exit 1 }
}
