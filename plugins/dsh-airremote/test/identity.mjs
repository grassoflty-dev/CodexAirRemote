import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BoardSession, SerialHolder, pairingHandler, parsePairingReply, readBoardPairing } from './dist/host-test.js'

const dir = await mkdtemp(join(tmpdir(), 'airremote-pair-test-'))
try {
  await writeFile(join(dir, 'pairing.txt'), 'a'.repeat(64))
  assert.equal(readBoardPairing(dir), undefined)
  const session = new BoardSession({ config: { dataDir: dir, pairingToken: 'a'.repeat(64), boardHost: '127.0.0.1', boardPort: 1 } })
  await session.start()
  assert.match((await session.finished).detail, /USB/)
  const nonce = 'a'.repeat(32)
  assert.equal(parsePairingReply('AR1P OK ' + 'b'.repeat(32) + ' secret', nonce), undefined)
  assert.throws(() => parsePairingReply(`AR1P OK ${nonce} not-cert`, nonce), /invalid USB pairing reply/)
  const holder = new SerialHolder()
  assert.equal(holder.acquire('flash'), true)
  const handle = pairingHandler(dir, holder)
  const req = (remoteAddress, host, origin, header) => ({ method: 'POST', socket: { remoteAddress },
    headers: { host, origin, 'x-airremote-pairing': header } })
  async function status(request) {
    let actual
    await handle(request, { writeHead(code) { actual = code }, end() {} })
    return actual
  }
  assert.equal(await status(req('192.168.1.20', '127.0.0.1:1234', undefined, '1')), 403)
  assert.equal(await status(req('127.0.0.1', '127.0.0.1:1234', 'https://foreign.example', '1')), 403)
  assert.equal(await status(req('127.0.0.1', '127.0.0.1:1234', undefined, undefined)), 403)
  assert.equal(await status(req('127.0.0.1', '127.0.0.1:1234', undefined, '1')), 409)
  assert.equal(holder.state().holder, 'flash')
  console.log('ok  real voice fails closed; USB nonce/origin/header/serial holder checks')
} finally {
  await rm(dir, { recursive: true, force: true })
}
