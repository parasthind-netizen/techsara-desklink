# uninstall.ps1
# This script completely removes the Remote Client background service and persistence.

Write-Host "----------------------------------------------------" -ForegroundColor Red
Write-Host "    REMOTE CLIENT UNINSTALLER                       " -ForegroundColor Red
Write-Host "----------------------------------------------------" -ForegroundColor Red

# 1. Stop the running process
Write-Host "[1/3] Stopping background processes..." -ForegroundColor Cyan
Stop-Process -Name "Remote Client Service" -Force -ErrorAction SilentlyContinue
Stop-Process -Name "RemoteClient" -Force -ErrorAction SilentlyContinue
Stop-Process -Name "electron" -Force -ErrorAction SilentlyContinue

# 2. Remove Registry Startup keys
Write-Host "[2/3] Removing Windows Registry Startup entry..." -ForegroundColor Cyan
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "TechsaraRemoteClient" -ErrorAction SilentlyContinue
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "RemoteClientService" -ErrorAction SilentlyContinue

# 3. Delete Scheduled Tasks
Write-Host "[3/3] Deleting the Watchdog Tasks..." -ForegroundColor Cyan
Unregister-ScheduledTask -TaskName "TechsaraRemoteWatchdog" -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "RemoteClientWatchdog" -Confirm:$false -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "SUCCESS! The remote support software has been removed." -ForegroundColor Green
Write-Host "Persistence and Watchdog tasks are now deleted." -ForegroundColor Green
Write-Host "You can now delete the folder if you wish." -ForegroundColor Yellow
Write-Host ""
Write-Host "Press any key to exit..."
$Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown") | Out-Null
