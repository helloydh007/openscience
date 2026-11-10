const { contextBridge, ipcRenderer } = require("electron")

// The main process checks the sending window and frame. No generic IPC or
// filesystem access is exposed, and remote workspace windows have no preload.
contextBridge.exposeInMainWorld("openscienceDesktop", {
  openWorkspace: (url) => ipcRenderer.invoke("openscience:open-workspace", url),
  ssh: {
    list: () => ipcRenderer.invoke("openscience:ssh:list"),
    save: (input) => ipcRenderer.invoke("openscience:ssh:save", input),
    remove: (id) => ipcRenderer.invoke("openscience:ssh:remove", id),
    connect: (id) => ipcRenderer.invoke("openscience:ssh:connect", id),
    disconnect: (id) => ipcRenderer.invoke("openscience:ssh:disconnect", id),
    onEvent: (callback) => {
      const listener = (_event, event) => callback(event)
      ipcRenderer.on("openscience:ssh:event", listener)
      return () => ipcRenderer.removeListener("openscience:ssh:event", listener)
    },
  },
})
