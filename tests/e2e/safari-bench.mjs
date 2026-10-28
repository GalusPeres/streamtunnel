#!/usr/bin/env node
// Measures the native path's page side in Safari (the engine of the Mac app's WKWebView): tests/e2e/bench.html
// records a 1440p60 H.264 / HEVC stream with WebCodecs and feeds it at 60 fps to a decoder that drops each frame,
// draws it on a 2D canvas, or uploads it to WebGL2, and to the app's NvVideoRenderer. Runs on macOS through
// safaridriver (WebDriver); started by .github/workflows/mac-bench.yml. Prints the results as JSON.
//
//   sudo safaridriver --enable   (once)
//   node tests/e2e/safari-bench.mjs
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const VITE_PORT = 5199
const WD_PORT = 4444
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const log = (...a) => console.error(`[safari-bench ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a)

async function waitHttp(url, what) {
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(1000) })
      return
    } catch { /* not up yet */ }
    await sleep(250)
  }
  throw new Error(`${what} did not come up`)
}

async function wd(method, path, body) {
  const r = await fetch(`http://127.0.0.1:${WD_PORT}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const j = await r.json()
  if (!r.ok) throw new Error(`${method} ${path}: ${JSON.stringify(j.value ?? j)}`)
  return j.value
}

const vite = spawn('npx', ['vite', '--port', String(VITE_PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' })
const driver = spawn('safaridriver', ['-p', String(WD_PORT)], { stdio: 'inherit' })
let session = null
let code = 0
try {
  await waitHttp(`http://localhost:${VITE_PORT}/tests/e2e/bench.html`, 'vite')
  await waitHttp(`http://127.0.0.1:${WD_PORT}/status`, 'safaridriver')
  session = (await wd('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } })).sessionId
  await wd('POST', `/session/${session}/window/maximize`, {}).catch(() => {})
  await wd('POST', `/session/${session}/timeouts`, { script: 900_000 })
  await wd('POST', `/session/${session}/url`, { url: `http://localhost:${VITE_PORT}/tests/e2e/bench.html` })
  for (let i = 0; i < 120; i++) {
    if (await wd('POST', `/session/${session}/execute/sync`, { script: 'return !!window.benchReady', args: [] })) break
    if (i === 119) throw new Error('bench page did not load')
    await sleep(250)
  }
  log('running')
  // started here, polled below: one long WebDriver call would hit fetch's 300 s header timeout, and a hang would
  // leave nothing; the page keeps its partial results in window.benchOut and its stage in window.benchStage
  await wd('POST', `/session/${session}/execute/sync`, {
    script: 'window.benchStage = "start"; window.benchDone = null; window.bench(arguments[0]).then((r) => (window.benchDone = r), (e) => (window.benchDone = { error: String((e && e.stack) || e) })); return true',
    args: [{ W: 2560, H: 1440, fps: 60, N: 240 }],
  })
  let result = null
  let stage = ''
  const deadline = Date.now() + 15 * 60_000
  while (!result) {
    await sleep(3000)
    const s = await wd('POST', `/session/${session}/execute/sync`, { script: 'return [window.benchStage, window.benchDone ? JSON.stringify(window.benchDone) : null]', args: [] })
    if (s[0] !== stage) log((stage = s[0]))
    if (s[1]) result = JSON.parse(s[1])
    else if (Date.now() > deadline) {
      const partial = await wd('POST', `/session/${session}/execute/sync`, { script: 'return JSON.stringify(window.benchOut || null)', args: [] })
      result = { error: `timed out in stage '${stage}'`, partial: JSON.parse(partial) }
    }
  }
  console.log(JSON.stringify(result, null, 2))
  if (result?.error) code = 1
} catch (err) {
  console.error(err)
  code = 1
} finally {
  if (session) await wd('DELETE', `/session/${session}`).catch(() => {})
  driver.kill()
  vite.kill()
}
process.exit(code)
