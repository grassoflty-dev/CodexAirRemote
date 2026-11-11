/**
 * Mint the DSH browser-session cookie from the signing secret in
 * `~/.dsh/.credentials.yaml`, so a separate browser can open the Web GUI
 * without the launch token printed by the app. This is a local test helper.
 */

import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function secretFromCredentials() {
  const path = process.env.DSH_CREDENTIALS ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml')
  const text = readFileSync(path, 'utf8')
  const match = /client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]{43})/.exec(text)
  if (match === null) throw new Error('browser-session secret not found in credentials')
  return Buffer.from(match[1], 'base64url')
}

export function mintCookie(authority = '127.0.0.1:57648', days = 30) {
  const secret = secretFromCredentials()
  const b64u = (value) => Buffer.from(value).toString('base64url')
  const name = `dsh-auth-${b64u(createHash('sha256').update(authority).digest())}`
  const issuedAt = Date.now()
  const expiresAt = issuedAt + days * 24 * 60 * 60 * 1000
  const body = b64u(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }))
  const signature = b64u(createHmac('sha256', secret).update(body).digest())
  const value = `v1.${body}.${signature}`
  return { name, value, header: `${name}=${value}` }
}
