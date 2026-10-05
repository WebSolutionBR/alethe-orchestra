/**
 * Secret redaction for everything the scribe keeps or sends: session material, the author's
 * prompt and every note it writes. The vault syncs through a cloud drive, so a token that
 * reaches a note is a leak. Pure and idempotent: redacting twice changes nothing.
 */

/** What a secret is replaced with; written in the vault's language. */
export const REDACTED = '[redigido]'

const PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g

/** Tokens recognizable by their own shape, wherever they appear. */
const TOKEN_SHAPES: RegExp[] = [
  // GitHub tokens (classic and fine-grained).
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // OpenAI / Anthropic style keys (sk-..., sk-ant-...).
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // AWS access key ids.
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Slack tokens.
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  // JSON Web Tokens.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
]

/** `Authorization: Bearer <token>` and friends. */
const AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+(?!\[redigido\])[A-Za-z0-9._~+/=-]{8,}/g

/** `scheme://user:password@host` keeps the user; `scheme://token@host` loses the token. */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):(?!\[redigido\])([^\s@/]+)@/gi
const URL_TOKEN = /\b([a-z][a-z0-9+.-]*:\/\/)([A-Za-z0-9_-]{16,})@/gi

/** A value right after a separator: quoted, or bare up to a space or a delimiter. */
const VALUE = /"[^"\n]*"|'[^'\n]*'|[^\s"'`,;)}\]]+/y

/**
 * `NAME=value`, `name: value`, `"name": "value"` (env lines, YAML, JSON, query strings). A colon
 * only counts when a space or a quote follows it, so `$env:NAME = value` is read as `NAME`.
 * Only the name and the separator are matched, so a value is scanned for more names
 * (`code=1&token=x`).
 */
const ASSIGNMENT =
  /(?<![A-Za-z0-9_])(["']?)([A-Za-z][A-Za-z0-9_.-]{0,63})\1(\s*:?=\s*|\s*:(?:\s+|(?=["'])))/g

/** `--api-key value` and `-token=value` style flags. */
const FLAG = /(?<![A-Za-z0-9_-])(--?)([A-Za-z][A-Za-z0-9_-]{0,63})(\s+|=)/g

/** Masks the value after every `name<sep>` match of `pattern` whose name says secret. */
function maskValues(text: string, pattern: RegExp): string {
  let out = ''
  let copied = 0
  pattern.lastIndex = 0
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const end = match.index + match[0].length
    VALUE.lastIndex = end
    const value = VALUE.exec(text)?.[0]
    if (value && secretName(match[2]) && !harmless(value)) {
      out += text.slice(copied, end) + mask(value)
      copied = end + value.length
      pattern.lastIndex = copied
    } else if (match[0].length === 0) {
      pattern.lastIndex++
    }
  }
  return out + text.slice(copied)
}

/**
 * Names that say secret: anything with TOKEN, SECRET or PASSWORD in it (and the Portuguese
 * "senha"), and keys (`API_KEY`, `apiKey`, `key`), but not words that merely contain "key"
 * (`keyboard`, `monkey`).
 */
export function secretName(name: string): boolean {
  const lower = name.toLowerCase()
  if (/(token|secret|password|passwd|passphrase|credential|senha)/.test(lower)) return true
  if (/(^|[_.-])(pwd|pass)$/.test(lower)) return true
  if (lower === 'key' || /(^|[_.-])key$/.test(lower) || /api[_-]?key$/.test(lower)) return true
  // camelCase keys: apiKey, accessKey, privateKey.
  return /[a-z0-9]Key$/.test(name)
}

function harmless(value: string): boolean {
  const bare = value.replace(/^["']|["']$/g, '').trim()
  if (bare.length < 3) return true
  // Already masked (the closing bracket is not part of a bare value), or another flag.
  if (bare.startsWith('[redigido') || bare.startsWith('-')) return true
  if (/^(true|false|null|undefined|none|nil)$/i.test(bare)) return true
  // Counts and limits (`max_tokens: 4096`) are not secrets.
  if (/^\d{1,9}$/.test(bare)) return true
  // References to where a secret lives, not the secret itself.
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(bare) || /^%[A-Za-z_][A-Za-z0-9_]*%$/.test(bare))
    return true
  return false
}

function mask(value: string): string {
  return /^["']/.test(value) ? `${value[0]}${REDACTED}${value[0]}` : REDACTED
}

/** Masks every secret in `text`. */
export function redactSecrets(text: string): string {
  if (!text) return text
  let out = text.replace(PRIVATE_KEY, REDACTED)
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, REDACTED)
  out = out.replace(AUTH_SCHEME, (_, scheme: string) => `${scheme} ${REDACTED}`)
  out = out.replace(
    URL_PASSWORD,
    (_, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`,
  )
  out = out.replace(URL_TOKEN, (_, scheme: string) => `${scheme}${REDACTED}@`)
  out = maskValues(out, ASSIGNMENT)
  out = maskValues(out, FLAG)
  return out
}

/** True when `text` holds something `redactSecrets` would mask. */
export function hasSecret(text: string): boolean {
  return redactSecrets(text) !== text
}
