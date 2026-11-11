# Runs every automated test against throw-away scratch servers (never the live
# one). From the project root:
#
#   .\tests\run-all.ps1                         server suites + both browser suites
#   .\tests\run-all.ps1 -SkipUi                 server suites only (faster)
#   .\tests\run-all.ps1 -Port 4011 -Name a      use another port / scratch folder, so two
#                                               runs (or a run and a hand-test) do not collide
#
# Prints failures in full and one result line per suite; exit code 1 if anything
# failed. A suite also counts as failed when it exits non-zero, prints no
# result lines, or does not finish in time. ASCII-only (PowerShell 5.1).
param([switch]$SkipUi, [int]$Port = 3998, [string]$Name = '')
$ErrorActionPreference = 'Continue'
$tests   = $PSScriptRoot
$root    = Split-Path -Parent $tests
$scratch = Join-Path $env:TEMP ('desklink-scratch' + $(if ($Name) { "-$Name" } else { '' }))
$server  = Join-Path $tests 'scratch-server.ps1'
$env:DL_TEST_URL = "http://127.0.0.1:$Port"
New-Item -ItemType Directory -Force $scratch | Out-Null

$where   = @{ Port = $Port; Name = $Name }
$rollout = @{ AdminUser = 'tester'; AdminPass = 'test1234'; WinFeed = '1.3.9'; MacFeed = '1.4.0'; ArchiveWin = @('1.3.8') }
$suites = @(
  @{ file = 'e2e-sessions.js';             args = @{ SupportGraceMs = 1500; ClientGraceMs = 2500 } },
  @{ file = 'e2e-tenant.js';               args = @{} },
  @{ file = 'e2e-team.js';                 args = @{} },
  @{ file = 'e2e-limit.js';                args = @{} },
  @{ file = 'e2e-brand.js';                args = @{} },
  @{ file = 'e2e-availability-rollout.js'; args = $rollout },
  @{ file = 'e2e-rollback.js';             args = $rollout }
)
# Any further e2e-*.js in this folder runs too, on a default server.
$known = $suites | ForEach-Object { $_.file }
Get-ChildItem (Join-Path $tests 'e2e-*.js') | Sort-Object Name | ForEach-Object {
  if ($known -notcontains $_.Name) { $suites += @{ file = $_.Name; args = @{} } }
}

$total = 0; $failed = 0; $summary = @()
function Add-Result([string]$name, $out, $code) {
  $pass = @($out | Where-Object { $_ -match '^PASS ' }).Count
  $fail = @($out | Where-Object { $_ -match '^FAIL ' }).Count
  $script:total += $pass + $fail
  $script:failed += $fail
  $broken = ($null -eq $code) -or ($code -ne 0) -or (($pass + $fail) -eq 0)
  if ($broken -or $fail -gt 0) {
    Write-Output "----- ${name}: FAILURES -----"
    $out | Where-Object { $_ -notmatch '^PASS ' } | ForEach-Object { Write-Output $_ }
    if ($null -eq $code) { Write-Output "(no exit code - counted as a failure)" }
    elseif ($code -ne 0) { Write-Output "(exit code $code)" }
    if (($pass + $fail) -eq 0) { Write-Output "(no PASS/FAIL lines - counted as a failure)" }
    if ($fail -eq 0) { $script:failed++ }
  }
  $script:summary += ("{0,-30} {1,3} passed, {2} failed" -f $name, $pass, $fail)
}

# Runs one Electron browser suite with a parse check and a hard time limit.
function Invoke-BrowserSuite([string]$file, [string]$label, [int]$minutes) {
  $electron = Join-Path $root 'client\node_modules\electron\dist\electron.exe'
  $js  = Join-Path $tests $file
  $out = Join-Path $scratch ($file + '.out.log')
  $err = Join-Path $scratch ($file + '.err.log')
  Remove-Item $out, $err -ErrorAction SilentlyContinue
  # A script that does not parse makes Electron show an (invisible) error
  # box and wait forever - check first, and never wait without a limit.
  & node --check $js
  if ($LASTEXITCODE -ne 0) { Add-Result $label @("FAIL $file does not parse") 1; return }
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # VS Code terminals set it
  $p = Start-Process -FilePath $electron -ArgumentList "`"$js`"", "`"$(Join-Path $scratch 'creds.json')`"" `
    -WorkingDirectory $scratch -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
  $null = $p.Handle   # PowerShell 5.1 only reports ExitCode if the handle was opened while the process ran
  if (-not $p.WaitForExit($minutes * 60 * 1000)) {
    try { Stop-Process -Id $p.Id -Force } catch {}
    Add-Result $label (@(Get-Content $out -ErrorAction SilentlyContinue) + "FAIL $file did not finish within $minutes minutes") 1
    return
  }
  $p.WaitForExit()
  $lines = @(Get-Content $out -ErrorAction SilentlyContinue)
  if (Test-Path $err) { $lines += @(Get-Content $err -ErrorAction SilentlyContinue | Where-Object { $_ -match 'Error|error:' } | Select-Object -First 20) }
  Add-Result $label $lines $p.ExitCode
}

# unit tests that need no server
$out = & node (Join-Path $tests 'unit-watchdog.js') 2>&1 | ForEach-Object { "$_" }
Add-Result 'unit-watchdog.js' $out $LASTEXITCODE

foreach ($s in $suites) {
  $a = $s.args + $where
  $up = & $server @a
  if (-not ("$up" -match 'SERVER UP')) { Write-Output "[$($s.file)] scratch server did not start: $up"; $failed++; continue }
  $out = & node (Join-Path $tests $s.file) 2>&1 | ForEach-Object { "$_" }
  Add-Result $s.file $out $LASTEXITCODE
}

if (-not $SkipUi) {
  $electron = Join-Path $root 'client\node_modules\electron\dist\electron.exe'
  if (-not (Test-Path $electron)) {
    Write-Output "browser suites skipped: run 'npm install' in client first (it provides the browser)."
  } else {
    foreach ($b in @(@{ file = 'ui-e2e.js'; label = 'ui-e2e.js (browser)'; min = 12 },
                     @{ file = 'ui-session.js'; label = 'ui-session.js (WebRTC)'; min = 8 })) {
      $up = & $server -Seed -NoMac @where
      if (-not ("$up" -match 'SEEDED')) { Write-Output "[$($b.file)] scratch server did not start: $up"; $failed++; continue }
      Invoke-BrowserSuite $b.file $b.label $b.min
    }
  }
}

& $server -StopOnly @where | Out-Null
Write-Output ''
Write-Output '===== SUMMARY ====='
$summary | ForEach-Object { Write-Output $_ }
Write-Output ("TOTAL: {0} checks, {1} failed" -f $total, $failed)
if ($failed -gt 0) { exit 1 }
