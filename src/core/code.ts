// Room codes: 10 chars Crockford base32 (50 bits of entropy), displayed "XXXXX-XXXXX".
// Pure module (no DOM) — also runs under Node.

export const CODE_LENGTH = 10

/** Crockford base32 alphabet (no I, L, O, U). */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

const CANONICAL_RE = /^[0-9A-HJKMNP-TV-Z]{10}$/
/** Separators users type or paste: whitespace, '-', '_' and Unicode dashes/minus. */
const SEPARATORS_RE = /[\s_\-‐-―−]+/g
/** Longest input we bother scanning for an embedded code (pasted invite texts are short). */
const MAX_SCAN_LENGTH = 2000

/** New random room code, canonical form (no dash). */
export function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH))
  let out = ''
  // 256 is a multiple of 32, so `byte & 31` is uniform.
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i] & 31]
  return out
}

/** Maps look-alike letters and checks the result; `s` must already be uppercase without separators. */
function canonicalize(s: string): string | null {
  if (s.length !== CODE_LENGTH) return null
  const mapped = s.replace(/O/g, '0').replace(/[IL]/g, '1')
  return CANONICAL_RE.test(mapped) ? mapped : null
}

/** Code-shaped tokens inside longer text: "XXXXX-XXXXX" first, then "XXXXX XXXXX" / "XXXXXXXXXX". */
const TOKEN_PATTERNS = [
  /(?<![0-9A-Z])[0-9A-Z]{5}[-_‐-―−][0-9A-Z]{5}(?![0-9A-Z])/g,
  /(?<![0-9A-Z])[0-9A-Z]{5}[-_\s‐-―−]?[0-9A-Z]{5}(?![0-9A-Z])/g,
]

/** Uppercases, strips spaces/dashes/underscores, maps O→0 and I/L→1; accepts a pasted invite text containing the code; returns canonical 10-char code or null. */
export function normalizeCode(input: string): string | null {
  if (typeof input !== 'string') return null
  const upper = input.slice(0, MAX_SCAN_LENGTH).toUpperCase()
  const direct = canonicalize(upper.replace(SEPARATORS_RE, ''))
  if (direct) return direct
  // Longer text (e.g. "Code: K7F3Q-X9MZD (StreamTunnel)"): first code-shaped token that is valid.
  for (const pattern of TOKEN_PATTERNS) {
    for (const match of upper.matchAll(pattern)) {
      const code = canonicalize(match[0].replace(SEPARATORS_RE, ''))
      if (code) return code
    }
  }
  return null
}

/**
 * "K7F3QX9MZD" → "K7F3Q-X9MZD". Purely cosmetic: uppercases, removes separators and inserts the dash
 * after 5 chars, so it also works for partial input while typing ("k7f3qx" → "K7F3Q-X").
 */
export function formatCode(canonical: string): string {
  const s = String(canonical).toUpperCase().replace(SEPARATORS_RE, '')
  return s.length > 5 ? `${s.slice(0, 5)}-${s.slice(5)}` : s
}
