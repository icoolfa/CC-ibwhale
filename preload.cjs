/**
 * Preload Bridge - 仅暴露 IPC
 */
const { ipcRenderer } = require('electron');

window.electronAPI = {
  sendInput: (data) => ipcRenderer.send('pty-input', data),
  sendResize: (cols, rows) => ipcRenderer.send('pty-resize', { cols, rows }),
  killProcess: () => ipcRenderer.send('pty-kill'),
  spawnProcess: () => ipcRenderer.send('pty-spawn'),
  setModelEnv: (cfg) => ipcRenderer.send('set-model-env', cfg),
  onOutput: (callback) => {
    const h = (_e, d) => callback(d);
    ipcRenderer.on('pty-output', h);
    return () => ipcRenderer.removeListener('pty-output', h);
  },
  onExit: (callback) => {
    const h = (_e, c) => callback(c);
    ipcRenderer.on('pty-exit', h);
    return () => ipcRenderer.removeListener('pty-exit', h);
  },
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  loadConfig: (userName) => ipcRenderer.invoke('config-load', userName),
  saveConfig: (cfg) => ipcRenderer.invoke('config-save', cfg),
  renameConfig: (oldName, newName) => ipcRenderer.invoke('config-rename', { oldName, newName }),
  deleteConfig: (userName) => ipcRenderer.invoke('config-delete', userName),
  translate: (text) => ipcRenderer.invoke('translate', text),
  // Conversation management
  newConv: () => ipcRenderer.invoke('conv-new'),
  switchConv: (id) => ipcRenderer.invoke('conv-switch', id),
  deleteConv: (id) => ipcRenderer.invoke('conv-delete', id),
  renameConv: (id, title) => ipcRenderer.invoke('conv-rename', { id, title }),
  getConvList: () => ipcRenderer.invoke('conv-list'),
  killConv: (id) => ipcRenderer.send('conv-kill', id),
  restartConv: (id) => ipcRenderer.send('conv-restart', id),
  onConvExit: (callback) => {
    const h = (_e, id) => callback(id);
    ipcRenderer.on('conv-exit', h);
    return () => ipcRenderer.removeListener('conv-exit', h);
  },
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  openUrl: (url) => ipcRenderer.send('open-url', url),
  autoUpdate: () => ipcRenderer.invoke('auto-update'),
  onUpdateProgress: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('update-progress', h);
    return () => ipcRenderer.removeListener('update-progress', h);
  },
  openNewWindow: () => ipcRenderer.send('open-new-window'),
  toggleWhip: () => ipcRenderer.send('toggle-whip'),
};
