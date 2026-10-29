// Gives the page (our own server only) the native folder picker; nothing else of Electron is exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentControl', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
});
