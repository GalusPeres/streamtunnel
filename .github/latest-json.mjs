// Writes release-assets/latest.json for the in-app updater (src-tauri/src/update.rs) from the renamed release files
// and their minisign signatures (.sig next to each). Run by the release job in .github/workflows/build.yml with
// V = version and U = the release's download URL. Every kind of install needs its entry: a missing one fails the job.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const { V, U } = process.env
if (!V || !U) throw new Error('V and U must be set')
const files = {
  'windows-x86_64': `StreamTunnel-${V}-Windows-Setup.exe`,
  'darwin-aarch64': `StreamTunnel-${V}-Mac-Update.app.tar.gz`,
  'linux-x86_64-appimage': `StreamTunnel-${V}-Linux.AppImage`,
  'linux-x86_64-deb': `StreamTunnel-${V}-Linux.deb`,
  // the tar.gz's binary and the Arch package (/usr/bin/streamtunnel)
  'linux-x86_64-bin': `StreamTunnel-${V}-Linux-x86_64-Update.bin`,
}
const platforms = {}
for (const [key, file] of Object.entries(files)) {
  const sig = `release-assets/${file}.sig`
  if (!existsSync(`release-assets/${file}`) || !existsSync(sig)) {
    console.log(`::error::no signed ${file}`)
    process.exitCode = 1
    continue
  }
  platforms[key] = { url: `${U}/${file}`, signature: readFileSync(sig, 'utf8').trim() }
}
writeFileSync('release-assets/latest.json', JSON.stringify({ version: V, pub_date: new Date().toISOString(), platforms }, null, 2))
console.log(`latest.json: ${Object.keys(platforms).join(', ')}`)
