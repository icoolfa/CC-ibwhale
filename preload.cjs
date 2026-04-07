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
  loadConfig: () => ipcRenderer.invoke('config-load'),
  saveConfig: (cfg) => ipcRenderer.invoke('config-save', cfg),
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
};
