const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  handleInput:      (data) => ipcRenderer.send('handle-input', data),
  getScreenSources: ()     => ipcRenderer.invoke('get-screen-sources'),
  getMachineName:   ()     => ipcRenderer.invoke('get-machine-name'),
  clipboardRead:    ()     => ipcRenderer.invoke('clipboard-read'),
  clipboardWrite:   (text) => ipcRenderer.send('clipboard-write', text),
  // ── auto-update ──
  checkForUpdate:   (opts) => ipcRenderer.invoke('check-for-update', opts || {}),
  setSessionState:  (b)    => ipcRenderer.send('session-state', b),
  getAppVersion:    ()     => ipcRenderer.invoke('get-app-version'),
  onUpdateStatus:   (cb)   => ipcRenderer.on('update-status', (_e, d) => cb(d)),
  // ── platform / macOS permissions ──
  getPlatform:            ()      => ipcRenderer.invoke('get-platform'),
  getPermissions:         ()      => ipcRenderer.invoke('get-permissions'),
  requestAccessibility:   ()      => ipcRenderer.invoke('request-accessibility'),
  openPermissionSettings: (which) => ipcRenderer.invoke('open-permission-settings', which),
  relaunchApp:            ()      => ipcRenderer.invoke('relaunch-app'),
});
