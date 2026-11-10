; electron-builder hook (build/installer.nsh is picked up automatically).
; The app registers a per-user Scheduled Task ("DeskLink Watchdog") that
; restarts DeskLink when it is killed and starts it at logon. Remove it on
; uninstall so nothing tries to launch a missing exe afterwards. (The
; uninstaller already ends every running DeskLink.exe, watchdog included.)
!macro customUnInstall
  nsExec::ExecToLog 'schtasks /delete /tn "DeskLink Watchdog" /f'
!macroend
