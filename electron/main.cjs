// Electron shell for Linux (Tauri on Linux = WebKitGTK, which ships without WebRTC). Loads the same Vite
// build (dist/) through a privileged app:// scheme so absolute /assets/ paths, WebCrypto (secure context)
// and localStorage behave like in the Tauri/WebView2 build.
//
//   electron .            normal start
//   electron . --smoke    headless self-test: loads the app, checks WebRTC + WebCrypto, exits 0/1
'use strict'

const { app, BrowserWindow, desktopCapturer, ipcMain, net, powerSaveBlocker, protocol, session } = require('electron')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const SMOKE = process.argv.includes('--smoke')
const DIST = path.join(__dirname, '..', 'dist')
const ICON = path.join(__dirname, 'icon.png')
const IS_LINUX = process.platform === 'linux'
const IS_WAYLAND = IS_LINUX && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY)

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
if (IS_LINUX) app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer')
else app.commandLine.appendSwitch('enable-features', 'WebRtcAV1HWEncode')

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
])

/** @type {BrowserWindow | null} */
let win = null
let awakeId = -1
/** @type {{ width: number, height: number } | null} */
let miniRestore = null
/** name of the last captured window (for the stream title) */
let lastWindowName = null
let pickSeq = 0
/** @type {Map<number, (id: string | null) => void>} */
const pickWaiters = new Map()

function serveApp() {
  protocol.handle('app', (req) => {
    let rel
    try {
      rel = decodeURIComponent(new URL(req.url).pathname)
    } catch {
      return new Response('bad request', { status: 400 })
    }
    if (rel === '/' || rel === '') rel = '/index.html'
    const file = path.normalize(path.join(DIST, rel))
    if (file !== DIST && !file.startsWith(DIST + path.sep)) return new Response('forbidden', { status: 403 })
    return net.fetch(pathToFileURL(file).toString())
  })
}

/** Asks the renderer's picker overlay (src/ui/picker.ts); resolves null on cancel. */
function askRenderer(sources) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve(null)
    const id = ++pickSeq
    pickWaiters.set(id, resolve)
    win.webContents.send('picker:show', id, sources)
  })
}

ipcMain.on('picker:result', (_e, id, sourceId) => {
  const done = pickWaiters.get(id)
  if (!done) return
  pickWaiters.delete(id)
  done(typeof sourceId === 'string' ? sourceId : null)
})

function installCaptureHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } })
      if (!sources.length) return callback({})
      let chosen = null
      if (IS_WAYLAND || sources.length === 1) {
        // Wayland: the xdg-desktop-portal dialog already asked the user; getSources returns that choice.
        chosen = sources[0]
      } else {
        const list = sources.map((s) => ({
          id: s.id,
          name: s.name,
          kind: s.id.startsWith('screen:') ? 'screen' : 'window',
          thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : '',
        }))
        const picked = await askRenderer(list)
        chosen = picked ? (sources.find((s) => s.id === picked) ?? null) : null
      }
      if (!chosen) return callback({})
      lastWindowName = chosen.id.startsWith('window:') ? chosen.name : null
      /** @type {Electron.Streams} */
      const streams = { video: chosen }
      // System audio loopback exists on Windows only; Linux gets video (the UI shows "Kein Ton").
      if (process.platform === 'win32' && request.audioRequested) streams.audio = 'loopback'
      callback(streams)
    } catch (err) {
      console.error('display media request failed:', err)
      callback({})
    }
  })
}

function ipc() {
  const w = () => (win && !win.isDestroyed() ? win : null)
  ipcMain.on('win:minimize', () => w()?.minimize())
  ipcMain.on('win:toggleMaximize', () => {
    const x = w()
    if (!x) return
    if (x.isMaximized()) x.unmaximize()
    else x.maximize()
  })
  ipcMain.on('win:close', () => w()?.close())
  ipcMain.handle('win:isMaximized', () => !!w()?.isMaximized())
  ipcMain.handle('win:setFullscreen', (_e, on) => {
    w()?.setFullScreen(!!on)
    return true
  })
  ipcMain.handle('win:isFullscreen', () => !!w()?.isFullScreen())
  ipcMain.handle('win:setAlwaysOnTop', (_e, on) => {
    w()?.setAlwaysOnTop(!!on)
    return true
  })
  ipcMain.handle('win:setMiniPlayer', (_e, on) => {
    const x = w()
    if (!x) return false
    if (on) {
      if (x.isFullScreen()) x.setFullScreen(false)
      if (x.isMaximized()) x.unmaximize()
      const [width, height] = x.getContentSize()
      miniRestore = { width, height }
      x.setMinimumSize(320, 180)
      x.setContentSize(480, 270)
      x.setAlwaysOnTop(true)
    } else {
      x.setAlwaysOnTop(false)
      const r = miniRestore ?? { width: 1100, height: 760 }
      miniRestore = null
      x.setContentSize(Math.max(760, r.width), Math.max(640, r.height))
      x.setMinimumSize(760, 640)
    }
    return true
  })
  ipcMain.on('power:keepAwake', (_e, on) => {
    if (on && awakeId < 0) awakeId = powerSaveBlocker.start('prevent-display-sleep')
    else if (!on && awakeId >= 0) {
      if (powerSaveBlocker.isStarted(awakeId)) powerSaveBlocker.stop(awakeId)
      awakeId = -1
    }
  })
  ipcMain.handle('capture:windowTitle', () => lastWindowName)
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 760,
    minHeight: 640,
    show: false,
    frame: false,
    backgroundColor: '#0b0b0c',
    title: 'StreamTunnel',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  win.removeMenu()
  const sendMax = () => win && !win.isDestroyed() && win.webContents.send('win:maximized', win.isMaximized())
  win.on('maximize', sendMax)
  win.on('unmaximize', sendMax)
  win.on('closed', () => {
    win = null
    for (const done of pickWaiters.values()) done(null)
    pickWaiters.clear()
  })
  // External links open in the system browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void require('electron').shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) e.preventDefault()
  })
  if (!SMOKE) win.once('ready-to-show', () => win?.show())
  void win.loadURL('app://local/index.html')
  return win
}

async function smoke(w) {
  const timer = setTimeout(() => {
    console.error('SMOKE FAIL: timeout')
    app.exit(1)
  }, 30000)
  try {
    await new Promise((resolve, reject) => {
      if (!w.webContents.isLoading()) return resolve()
      w.webContents.once('did-finish-load', resolve)
      w.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(`load failed ${code} ${desc}`)))
    })
    await new Promise((r) => setTimeout(r, 1500))
    const res = await w.webContents.executeJavaScript(`(async () => {
      let ls = false
      try { localStorage.setItem('__st_smoke', '1'); ls = localStorage.getItem('__st_smoke') === '1'; localStorage.removeItem('__st_smoke') } catch {}
      let pc = false
      try { const p = new RTCPeerConnection(); p.createDataChannel('x'); await p.createOffer(); p.close(); pc = true } catch {}
      return {
        rtc: typeof RTCPeerConnection === 'function',
        offer: pc,
        subtle: !!(globalThis.crypto && crypto.subtle),
        secure: isSecureContext,
        localStorage: ls,
        displayMedia: !!(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function'),
        bridge: typeof window.__ELECTRON__ === 'object',
        rendered: (document.getElementById('app')?.childElementCount ?? 0) > 0,
        title: document.title,
      }
    })()`)
    const ok = res.rtc && res.offer && res.subtle && res.secure && res.localStorage && res.displayMedia && res.bridge && res.rendered
    console.log(`SMOKE ${ok ? 'OK' : 'FAIL'} ${JSON.stringify(res)} electron=${process.versions.electron} chrome=${process.versions.chrome}`)
    clearTimeout(timer)
    app.exit(ok ? 0 : 1)
  } catch (err) {
    console.error('SMOKE FAIL:', err)
    clearTimeout(timer)
    app.exit(1)
  }
}

if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
  app.whenReady().then(() => {
    serveApp()
    installCaptureHandler()
    ipc()
    const w = createWindow()
    if (SMOKE) void smoke(w)
  })
  app.on('window-all-closed', () => app.quit())
}
