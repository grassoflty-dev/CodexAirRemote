/**
 * Host-side runtime configuration.
 *
 * Values come from (highest priority first) the plugin entry config in
 * `cordis.patch.yml`, environment variables, and files under the DSH home:
 *
 *   ~/.dsh/airremote/pairing.txt  - the 64-character token embedded in the firmware
 *   ~/.dsh/airremote/server.crt   - the board's self-signed certificate (optional pin)
 *   ~/.dsh/airremote/sim.wav      - speech used by the simulated board
 *   ~/.dsh/airremote/time.json    - 设置页选的时区（`auto` 表示跟随系统）
 *
 * The pairing token is a secret: it is read from disk or the environment, never
 * from the committed profile patch.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface AirRemoteHostConfig {
  /** Directory holding local secrets/assets (`DSH_HOME/airremote`). */
  dataDir: string
  /** 64-character pairing token sent in the AUTH message. */
  pairingToken: string
  /** Board certificate used as a pin when present. */
  caFile: string
  /** Board address; empty means wait for the UDP announcement. */
  boardHost: string
  /** Board WSS port from `voice.c`. */
  boardPort: number
  /** UDP discovery port from `voice.c`. */
  discoveryPort: number
  /** How long a browser session waits for the board announcement. */
  discoveryTimeoutMs: number
  /** Run the in-process simulated board instead of the real one. */
  simulate: boolean
  /** WAV/raw PCM file looped by the simulated board. */
  simWav: string
  /** Local port for the simulated board's plain-WebSocket server. */
  simPort: number
  /** 写时间用的串口（如 `COM7`）；空串表示按 USB VID 303A 自动发现。 */
  serialPort: string
}

export interface AirRemoteHostConfigOverrides {
  dataDir?: string
  pairingToken?: string
  pairingTokenFile?: string
  caFile?: string
  boardHost?: string
  boardPort?: number
  discoveryPort?: number
  discoveryTimeoutMs?: number
  simulate?: boolean
  simWav?: string
  simPort?: number
  serialPort?: string
}

function env(name: string): string | undefined {
  const value = process.env[name]
  return value === undefined || value.trim() === '' ? undefined : value.trim()
}

function readToken(file: string): string {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
  } catch {
    return ''
  }
}

export function resolveHostConfig(overrides: AirRemoteHostConfigOverrides = {}): AirRemoteHostConfig {
  const dshHome = env('DSH_HOME') ?? join(homedir(), '.dsh')
  const dataDir = overrides.dataDir ?? env('AIRREMOTE_DATA_DIR') ?? join(dshHome, 'airremote')
  const tokenFile = overrides.pairingTokenFile ?? env('AIRREMOTE_PAIRING_FILE') ?? join(dataDir, 'pairing.txt')
  const pairingToken = overrides.pairingToken ?? env('AIRREMOTE_PAIRING_TOKEN') ?? readToken(tokenFile)
  const simulate =
    overrides.simulate ??
    (env('AIRREMOTE_SIMULATE') === '1' || existsSync(join(dataDir, 'simulate')))
  return {
    dataDir,
    pairingToken,
    caFile: overrides.caFile ?? env('AIRREMOTE_CA_FILE') ?? join(dataDir, 'server.crt'),
    boardHost: overrides.boardHost ?? env('AIRREMOTE_BOARD_HOST') ?? '',
    boardPort: overrides.boardPort ?? Number(env('AIRREMOTE_BOARD_PORT') ?? '47683'),
    discoveryPort: overrides.discoveryPort ?? Number(env('AIRREMOTE_DISCOVERY_PORT') ?? '47682'),
    discoveryTimeoutMs: overrides.discoveryTimeoutMs ?? Number(env('AIRREMOTE_DISCOVERY_TIMEOUT_MS') ?? '30000'),
    simulate,
    simWav: overrides.simWav ?? env('AIRREMOTE_SIM_WAV') ?? join(dataDir, 'sim.wav'),
    simPort: overrides.simPort ?? Number(env('AIRREMOTE_SIM_PORT') ?? '47684'),
    serialPort: overrides.serialPort ?? env('AIRREMOTE_SERIAL_PORT') ?? ''
  }
}

/** The simulated board needs a syntactically valid token; the value is never compared to the firmware. */
export function simulatedToken(config: AirRemoteHostConfig): string {
  return config.pairingToken.length === 64 ? config.pairingToken : '0'.repeat(64)
}
