const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("startupApi", {
  retry: () => ipcRenderer.invoke("startup:retry"),
  copy: (text) => ipcRenderer.invoke("startup:copy", String(text ?? "")),
});
