const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dshSci", {
  runAgent: (request) => ipcRenderer.invoke("run-agent", request),
  getConfig: (request) => ipcRenderer.invoke("get-config", request),
  chooseFolder: () => ipcRenderer.invoke("choose-folder"),
});
