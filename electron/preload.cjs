const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  pickCaptureSource: () => ipcRenderer.invoke('pick-capture-source'),
  setOverlayMode: (enable) => ipcRenderer.invoke('set-overlay-mode', enable),
  setClickThrough: (enable) => ipcRenderer.invoke('set-click-through', enable),
  setOverlayArranging: (enable) => ipcRenderer.invoke('set-overlay-arranging', enable),
  overlayResize: (phase, dx, dy) => ipcRenderer.send('overlay-resize', phase, dx, dy),
  setOverlayScale: (scale) => ipcRenderer.invoke('set-overlay-scale', scale),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  windowControl: (action) => ipcRenderer.invoke('window-control', action),
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  matchLog: {
    start: () => ipcRenderer.send('match-log-start'),
    write: (text) => ipcRenderer.send('match-log-write', text),
    image: (name, data) => ipcRenderer.send('match-log-image', name, data),
    end: () => ipcRenderer.send('match-log-end'),
    openFolder: () => ipcRenderer.invoke('open-match-logs'),
    info: () => ipcRenderer.invoke('match-logs-info'),
    deleteAll: () => ipcRenderer.invoke('delete-match-logs'),
  },
  createProblemReport: (payload) => ipcRenderer.invoke('create-problem-report', payload),
  updates: {
    check: () => ipcRenderer.invoke('check-for-updates'),
    status: () => ipcRenderer.invoke('get-update-status'),
    install: () => ipcRenderer.invoke('install-update'),
    onStatus: (callback) => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on('update-status', listener);
      return () => ipcRenderer.removeListener('update-status', listener);
    },
  },
  onOverlayStateChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('overlay-state-changed', listener);
    return () => ipcRenderer.removeListener('overlay-state-changed', listener);
  },
  onTriggerShortcutScan: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('trigger-shortcut-scan', listener);
    return () => ipcRenderer.removeListener('trigger-shortcut-scan', listener);
  },
});
