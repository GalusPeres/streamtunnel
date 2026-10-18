// Sandboxed preload: exposes a tiny window API as window.__ELECTRON__ (see src/platform.ts).
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/** @type {((list: unknown[]) => Promise<string | null>) | null} */
let picker = null

ipcRenderer.on('picker:show', async (_e, id, list) => {
  let chosen = null
  try {
    if (picker) chosen = await picker(list)
    else chosen = (list.find((s) => s.kind === 'screen') ?? list[0])?.id ?? null
  } catch {
    chosen = null
  }
  ipcRenderer.send('picker:result', id, typeof chosen === 'string' ? chosen : null)
})

contextBridge.exposeInMainWorld('__ELECTRON__', {
  platform: process.platform,
  minimize: () => ipcRenderer.send('win:minimize'),
  toggleMaximize: () => ipcRenderer.send('win:toggleMaximize'),
  close: () => ipcRenderer.send('win:close'),
  isMaximized: () => ipcRenderer.invoke('win:isMaximized'),
  onMaximize: (cb) => {
    const fn = (_e, m) => cb(!!m)
    ipcRenderer.on('win:maximized', fn)
    return () => ipcRenderer.removeListener('win:maximized', fn)
  },
  setFullscreen: (on) => ipcRenderer.invoke('win:setFullscreen', !!on),
  isFullscreen: () => ipcRenderer.invoke('win:isFullscreen'),
  setAlwaysOnTop: (on) => ipcRenderer.invoke('win:setAlwaysOnTop', !!on),
  setMiniPlayer: (on) => ipcRenderer.invoke('win:setMiniPlayer', !!on),
  keepAwake: (on) => ipcRenderer.send('power:keepAwake', !!on),
  /** title of the last captured window, or null for screens */
  windowTitle: () => ipcRenderer.invoke('capture:windowTitle'),
  /** registers the source picker used on X11 (Wayland uses the system portal dialog) */
  pickSource: (fn) => {
    picker = typeof fn === 'function' ? fn : null
  },
})
