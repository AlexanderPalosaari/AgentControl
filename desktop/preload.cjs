// Gives the page (our own server only) the native folder picker and the claude.ai artifact reader; nothing else of
// Electron is exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentControl', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  fetchArtifact: (link) => ipcRenderer.invoke('fetch-artifact', link),
});
