# install.ps1 (CLEAN VERSION)
# This script sets up the remote client without suspicious persistence.

$scriptPath = $MyInvocation.MyCommand.Path
$installDir = Split-Path $scriptPath
$exePath = Join-Path $installDir "Remote Client Service.exe"
if (-Not (Test-Path $exePath)) {
    $exePath = Join-Path $installDir "dist\win-unpacked\Remote Client Service.exe"
}

if (-Not (Test-Path $exePath)) {
    Write-Host "Error: Executable not found at $exePath." -ForegroundColor Red
    exit
}

Write-Host "Setting up Techsara Remote Support..." -ForegroundColor Cyan

# Just create a desktop shortcut instead of a hidden registry key
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("$([Environment]::GetFolderPath('Desktop'))\Techsara Support.lnk")
$Shortcut.TargetPath = $exePath
$Shortcut.Save()

Write-Host "Installation Complete! A shortcut 'Techsara Support' has been added to your Desktop." -ForegroundColor Green
Write-Host "You can now run the app from your desktop whenever you need support." -ForegroundColor White
