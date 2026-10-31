const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("researchCaseApi", {
  list: () => ipcRenderer.invoke("research:list"),
  exportProject: (id) => ipcRenderer.invoke("research:export", id),
  review: (input) => ipcRenderer.invoke("research:experiment-review", input),
  approveTask: (input) => ipcRenderer.invoke("research:approve", input),
  approveExperiment: (input) => ipcRenderer.invoke("research:approve-experiment", input),
  execute: (input) => ipcRenderer.invoke("research:execute-experiment", input),
});
