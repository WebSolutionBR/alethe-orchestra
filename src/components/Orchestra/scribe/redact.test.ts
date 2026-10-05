import { describe, expect, it } from 'vitest'

import { hasSecret, REDACTED, redactSecrets, secretName } from './redact'

describe('redactSecrets', () => {
  it('masks assignments whose name says secret, in env, YAML, JSON and query strings', () => {
    expect(redactSecrets('VERCEL_TOKEN=abc123def npx vercel deploy')).toBe(
      `VERCEL_TOKEN=${REDACTED} npx vercel deploy`,
    )
    expect(redactSecrets('OBSIDIAN_API_KEY: 9f8e7d6c5b4a')).toBe(`OBSIDIAN_API_KEY: ${REDACTED}`)
    expect(redactSecrets('{"apiKey": "c0ffee-1234", "port": 27124}')).toBe(
      `{"apiKey": "${REDACTED}", "port": 27124}`,
    )
    expect(redactSecrets('$env:CLIENT_SECRET = "s3cr3t-value"')).toBe(
      `$env:CLIENT_SECRET = "${REDACTED}"`,
    )
    expect(redactSecrets('password=hunter22 user=raul')).toBe(`password=${REDACTED} user=raul`)
    expect(redactSecrets('senha: minhaSenha!')).toBe(`senha: ${REDACTED}`)
    expect(redactSecrets('https://x.com/cb?code=1&token=XYZ987654')).toBe(
      `https://x.com/cb?code=1&token=${REDACTED}`,
    )
  })

  it('masks flags, bearer tokens and credentials in URLs', () => {
    expect(redactSecrets('wrangler deploy --api-key abc123xyz --env prod')).toBe(
      `wrangler deploy --api-key ${REDACTED} --env prod`,
    )
    expect(redactSecrets('curl -H "Authorization: Bearer abcdef0123456789"')).toBe(
      `curl -H "Authorization: Bearer ${REDACTED}"`,
    )
    expect(redactSecrets('git push https://raul:ghs_pass1234@github.com/x/y.git')).toBe(
      `git push https://raul:${REDACTED}@github.com/x/y.git`,
    )
    expect(redactSecrets('https://0123456789abcdef0123@github.com/x')).toBe(
      `https://${REDACTED}@github.com/x`,
    )
  })

  it('masks tokens by their shape wherever they appear', () => {
    const samples = [
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
      'sk-ant-api03-abcdefghijklmnopqrstuv',
      'AKIAIOSFODNN7EXAMPLE',
      'xoxb-1234567890-abcdefghij',
      'AIzaSyA1234567890abcdefghijklmnopqrstuv',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
    ]
    for (const token of samples) {
      const out = redactSecrets(`antes ${token} depois`)
      expect(out, token).toBe(`antes ${REDACTED} depois`)
    }
    expect(
      redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----'),
    ).toBe(REDACTED)
  })

  it('keeps what only looks like a secret', () => {
    const plain = [
      'keyboard: Ctrl+K',
      'monkey: banana',
      'max_tokens: 4096',
      'token: no',
      'OBSIDIAN_API_KEY=${OBSIDIAN_API_KEY}',
      'a chave fica no keyring',
      'Pontos-chave / decisões',
      'C:\\Users\\Profile\\token\\notes.md',
      'https://github.com/Kc1t/alethe-agents',
      'tempo: 14:05',
    ]
    for (const text of plain) expect(redactSecrets(text), text).toBe(text)
  })

  it('is idempotent', () => {
    const once = redactSecrets(
      'API_KEY="abc12345" Bearer abcdef0123456789 https://u:p4ssw0rd@h.com --token zzz999',
    )
    expect(redactSecrets(once)).toBe(once)
    expect(hasSecret(once)).toBe(false)
    expect(hasSecret('GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123')).toBe(true)
  })

  it('names secrets by their name', () => {
    for (const name of [
      'TOKEN',
      'apiKey',
      'API_KEY',
      'client_secret',
      'db.password',
      'key',
      'senha',
    ])
      expect(secretName(name), name).toBe(true)
    for (const name of ['keyboard', 'monkey', 'keys_count', 'turkey'])
      expect(secretName(name), name).toBe(false)
  })
})
