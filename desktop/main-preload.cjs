const { contextBridge, ipcRenderer } = require("electron");

if (typeof document !== "undefined") {
  const applyTitlebarAttr = () => {
    if (!document.documentElement) return;
    document.documentElement.setAttribute("data-windows-titlebar", "");
    document.documentElement.style.setProperty("--dsh-windows-titlebar-height", "38px");
  };
  applyTitlebarAttr();
  window.addEventListener("DOMContentLoaded", applyTitlebarAttr, { once: true });
}

contextBridge.exposeInMainWorld("startupApi", {
  retry: () => ipcRenderer.invoke("startup:retry"),
  copy: (text) => ipcRenderer.invoke("startup:copy", String(text ?? "")),
});

contextBridge.exposeInMainWorld("dshSciDesktop", {
  openResearchWorkspace: (access) =>
    ipcRenderer.invoke("desktop:open-research-workspace", access === "read-only" ? "read-only" : "owner"),
  openCaptureHistory: () => ipcRenderer.invoke("desktop:open-capture-history"),
  queueMetadataBackup: () => ipcRenderer.invoke("desktop:queue-metadata-backup"),
  setTitleBarTheme: (scheme) =>
    ipcRenderer.invoke("desktop:set-titlebar-theme", scheme === "dark" ? "dark" : "light"),
});

