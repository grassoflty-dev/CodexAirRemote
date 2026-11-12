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
export interface AirRemoteHostConfig {
    /** Directory holding local secrets/assets (`DSH_HOME/airremote`). */
    dataDir: string;
    /** 64-character pairing token sent in the AUTH message. */
    pairingToken: string;
    /** Board certificate used as a pin when present. */
    caFile: string;
    /** Board address; empty means wait for the UDP announcement. */
    boardHost: string;
    /** Board WSS port from `voice.c`. */
    boardPort: number;
    /** UDP discovery port from `voice.c`. */
    discoveryPort: number;
    /** How long a browser session waits for the board announcement. */
    discoveryTimeoutMs: number;
    /** Run the in-process simulated board instead of the real one. */
    simulate: boolean;
    /** WAV/raw PCM file looped by the simulated board. */
    simWav: string;
    /** Local port for the simulated board's plain-WebSocket server. */
    simPort: number;
    /** 写时间用的串口（如 `COM7`）；空串表示按 USB VID 303A 自动发现。 */
    serialPort: string;
}
export interface AirRemoteHostConfigOverrides {
    dataDir?: string;
    pairingToken?: string;
    pairingTokenFile?: string;
    caFile?: string;
    boardHost?: string;
    boardPort?: number;
    discoveryPort?: number;
    discoveryTimeoutMs?: number;
    simulate?: boolean;
    simWav?: string;
    simPort?: number;
    serialPort?: string;
}
export declare function resolveHostConfig(overrides?: AirRemoteHostConfigOverrides): AirRemoteHostConfig;
/** The simulated board needs a syntactically valid token; the value is never compared to the firmware. */
export declare function simulatedToken(config: AirRemoteHostConfig): string;
