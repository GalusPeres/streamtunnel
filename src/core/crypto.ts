// Room key / topic derivation and authenticated encryption of signaling payloads.
// WebCrypto only (works in WebView2 and Node 24).
//
//   ikm   = PBKDF2-HMAC-SHA256(code, "streamtunnel/v1/room", 250 000 iterations, 256 bit)
//   key   = HKDF-SHA256(ikm, salt = "", info = "key")   → AES-GCM-256 (non-extractable)
//   topic = "st2/" + hex(HKDF-SHA256(ikm, salt = "", info = "topic", 128 bit))
//
// Sealed format: 12-byte random IV ‖ AES-GCM ciphertext (incl. 16-byte tag); AAD = the FULL MQTT topic the
// payload is published to (B/h, B/b or B/p/<id>), so a captured ciphertext cannot be replayed onto another
// sub-topic. ("st2/": v1 sealed with the base topic only — the prefix bump keeps old builds on separate topics.)

export interface RoomKeys {
  /** MQTT topic for this room (derived, not reversible to the code) */
  topic: string
  /** AES-GCM-256 key for all signaling payloads */
  key: CryptoKey
}

export const PBKDF2_ITERATIONS = 250_000
export const TOPIC_PREFIX = 'st2/'
const ROOM_SALT = 'streamtunnel/v1/room'
const IV_BYTES = 12
const TAG_BYTES = 16

const encoder = new TextEncoder()
const strictDecoder = new TextDecoder('utf-8', { fatal: true })

const HEX: string[] = []
for (let i = 0; i < 256; i++) HEX.push(i.toString(16).padStart(2, '0'))

/** Lowercase hex of the given bytes. */
export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]]
  return out
}

export async function deriveRoomKeys(canonicalCode: string): Promise<RoomKeys> {
  if (typeof canonicalCode !== 'string' || canonicalCode.length === 0) throw new TypeError('deriveRoomKeys: empty code')
  const subtle = globalThis.crypto?.subtle
  // WebCrypto only exists in secure contexts (Tauri's tauri.localhost and localhost are fine).
  if (!subtle) throw new Error('Verschlüsselung nicht verfügbar (WebCrypto fehlt – unsicherer Kontext?).')
  const password = await subtle.importKey('raw', encoder.encode(canonicalCode), 'PBKDF2', false, ['deriveBits'])
  const ikmBits = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(ROOM_SALT), iterations: PBKDF2_ITERATIONS },
    password,
    256,
  )
  const ikm = await subtle.importKey('raw', ikmBits, 'HKDF', false, ['deriveKey', 'deriveBits'])
  const hkdf = (info: string): HkdfParams => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(info) })
  const [key, topicBits] = await Promise.all([
    subtle.deriveKey(hkdf('key'), ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
    subtle.deriveBits(hkdf('topic'), ikm, 128),
  ])
  return { topic: TOPIC_PREFIX + toHex(new Uint8Array(topicBits)), key }
}

/** JSON-encode + AES-GCM encrypt with `aad` as additional data. Output: 12-byte IV || ciphertext. */
export async function seal(key: CryptoKey, value: unknown, aad: string): Promise<Uint8Array> {
  const plain = encoder.encode(JSON.stringify(value) ?? 'null')
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad) }, key, plain)
  const out = new Uint8Array(IV_BYTES + cipher.byteLength)
  out.set(iv, 0)
  out.set(new Uint8Array(cipher), IV_BYTES)
  return out
}

/** Inverse of seal; returns null on any failure (wrong key, wrong aad, tampered, bad JSON). */
export async function unseal<T>(key: CryptoKey, data: Uint8Array, aad: string): Promise<T | null> {
  try {
    if (!(data instanceof Uint8Array) || data.length < IV_BYTES + TAG_BYTES) return null
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: data.slice(0, IV_BYTES), additionalData: encoder.encode(aad) },
      key,
      data.slice(IV_BYTES),
    )
    return JSON.parse(strictDecoder.decode(plain)) as T
  } catch {
    return null
  }
}

/**
 * Stable per-room viewer id: hex(HMAC-SHA256(installSecret, "viewer-id/" + canonicalCode))[0..16].
 * The same install gets the same id for the same code (so a host's kick/deny survives a plain rejoin) while ids
 * are not linkable across rooms. Falls back to a random id if WebCrypto or the secret is unavailable.
 */
export async function deriveViewerId(installSecret: string, canonicalCode: string): Promise<string> {
  try {
    const subtle = globalThis.crypto?.subtle
    if (!subtle || typeof installSecret !== 'string' || installSecret.length < 16) return randomId()
    const k = await subtle.importKey('raw', encoder.encode(installSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const mac = await subtle.sign('HMAC', k, encoder.encode(`viewer-id/${canonicalCode}`))
    return toHex(new Uint8Array(mac).slice(0, 8))
  } catch {
    return randomId()
  }
}

/** Random lowercase hex id with `bytes` bytes of entropy. */
export function randomId(bytes = 8): string {
  const n = Math.min(65536, Math.max(1, Math.floor(Number.isFinite(bytes) ? bytes : 8)))
  return toHex(crypto.getRandomValues(new Uint8Array(n)))
}
