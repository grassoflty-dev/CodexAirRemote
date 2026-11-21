import { randomBytes, X509Certificate } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PAIRING_FILE = 'device-pairing.json'
export const BOARD_TLS_NAME = 'airremote.local'

export interface BoardPairing {
  token: string
  certificate: string
  fingerprint: string
}

/** 只接受板子经 USB 提供的、有效且自签名的设备证书。 */
export function validateBoardPairing(token: unknown, certificate: string | Buffer): BoardPairing {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || /^0+$/.test(token)) {
    throw new Error('invalid device pairing token')
  }
  const x509 = new X509Certificate(certificate)
  const now = Date.now()
  if (x509.raw.length > 512 || !x509.ca || x509.subject !== x509.issuer ||
      !x509.checkHost(BOARD_TLS_NAME, { subject: 'never' }) || !x509.verify(x509.publicKey) ||
      x509.publicKey.asymmetricKeyType !== 'ec' || x509.publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1' ||
      !(Date.parse(x509.validFrom) <= now && now <= Date.parse(x509.validTo))) {
    throw new Error('invalid device certificate')
  }
  return { token, certificate: x509.toString(), fingerprint: x509.fingerprint256 }
}

export function readBoardPairing(dataDir: string): BoardPairing | undefined {
  try {
    const stored = JSON.parse(readFileSync(join(dataDir, PAIRING_FILE), 'utf8')) as { token?: unknown; certificate?: unknown }
    if (typeof stored.certificate === 'string') return validateBoardPairing(stored.token, stored.certificate)
  } catch {
    // 未配对、无效或无法读取时一律拒绝真实板连接，不退回旧凭据。
  }
  return undefined
}

export function writeBoardPairing(dataDir: string, pairing: BoardPairing): void {
  const verified = validateBoardPairing(pairing.token, pairing.certificate)
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const target = join(dataDir, PAIRING_FILE)
  const pending = join(dataDir, `.device-pairing-${randomBytes(8).toString('hex')}.tmp`)
  try {
    writeFileSync(pending, JSON.stringify({ token: verified.token, certificate: verified.certificate }) + '\n',
      { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    renameSync(pending, target)
  } finally {
    rmSync(pending, { force: true })
  }
}

/** 不把包含令牌的整行放进异常、HTTP 结果或日志。 */
export function parsePairingReply(line: string, nonce: string): BoardPairing | undefined {
  if (!line.startsWith(`AR1P OK ${nonce} `)) return undefined
  const match = /^AR1P OK [a-f0-9]{32} ([a-f0-9]{64}) ([a-f0-9]{2,1024})$/.exec(line)
  if (!match || match[2].length % 2 !== 0) throw new Error('invalid USB pairing reply')
  return validateBoardPairing(match[1], Buffer.from(match[2], 'hex'))
}
