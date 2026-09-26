const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("detoiloDesktop", {
  getStatus: () => ipcRenderer.invoke("get-status"),
  pair: (payload) => ipcRenderer.invoke("pair", payload),
  unpair: () => ipcRenderer.invoke("unpair"),
  onStatus: (fn) => {
    const listener = (_event, status) => fn(status);
    ipcRenderer.on("status", listener);
    return () => ipcRenderer.removeListener("status", listener);
  },
});
