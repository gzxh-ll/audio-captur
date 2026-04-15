const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  onRecorderState: (cb) => ipcRenderer.on("recorder:state", (_evt, state) => cb(state)),
  stop: () => ipcRenderer.send("overlay:stopClicked"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  chooseSaveDir: () => ipcRenderer.invoke("settings:chooseSaveDir")
});

