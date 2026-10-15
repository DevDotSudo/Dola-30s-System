const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Queue Controls
  startQueue: (payload) => ipcRenderer.invoke('queue:start', payload),
  stopQueue: () => ipcRenderer.invoke('queue:stop'),
  getQueueStatus: () => ipcRenderer.invoke('queue:status'),

  // Account Management
  loadAccounts: () => ipcRenderer.invoke('accounts:load'),
  deleteAccount: (accountId) => ipcRenderer.invoke('accounts:delete', accountId),
  resetAccount: (accountId) => ipcRenderer.invoke('accounts:reset', accountId),
  importCookies: (content) => ipcRenderer.invoke('accounts:import', content),
  checkAccountHealth: (accountId) => ipcRenderer.invoke('accounts:check-health', accountId),
  loginDolaWindow: () => ipcRenderer.invoke('accounts:login-window'),

  // File System & Utilities
  openOutputFolder: (folderPath) => ipcRenderer.invoke('fs:open-folder', folderPath),
  selectImageFile: () => ipcRenderer.invoke('fs:select-image'),

  importCookieFile: () => ipcRenderer.invoke('accounts:import-file'),

  // Event Streams
  onLog: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('studio-log', handler);
    return () => ipcRenderer.removeListener('studio-log', handler);
  },
  onStatus: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('studio-status', handler);
    return () => ipcRenderer.removeListener('studio-status', handler);
  },
  onAccountsUpdated: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('accounts-updated', handler);
    return () => ipcRenderer.removeListener('accounts-updated', handler);
  }
});
