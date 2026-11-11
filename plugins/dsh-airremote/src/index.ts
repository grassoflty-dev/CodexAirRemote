import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { AudioRoute } from './host/audio-route.js'
import { BoardDiscovery } from './host/discovery.js'
import { FakeBoard } from './host/fake-board.js'
import { resolveHostConfig, simulatedToken, type AirRemoteHostConfigOverrides } from './host/config.js'
import { FirmwareRoutes } from './host/firmware-routes.js'
import { FlashRoute } from './host/flash-route.js'
import { findBoardPort } from './host/serial-port.js'
import { SerialHolder, SerialRoutes } from './host/serial-holder.js'
import { TimeRoutes } from './host/time-routes.js'

/**
 * 内置固件目录：`lib/index.js` 的上一级（插件包根）下的 `firmware/`。
 * 用 `import.meta.url` 推，不用 `process.cwd()`、不写死仓库绝对路径，
 * 这样 npm link / 安装到 profile 之后都能找到包内文件。
 * （`lib/index.js` 与源码 `src/index.ts` 同在一个「上一级是包根」的深度，
 * 所以 dev、build 两种形态解析结果一致。）
 */
const FIRMWARE_DIR = fileURLToPath(new URL('../firmware', import.meta.url))

/**
 * dsh-airremote host entry.
 *
 * The host owns the board link and exposes it to the page over the
 * `dsh-host-webserver` upgrade route `/airremote/audio`. The client half
 * installs a synthetic microphone and feeds the official DSH voice-input
 * plugin, so this plugin never renders its own microphone button.
 */
export const name = 'dsh-airremote'

/** The upgrade route needs the Web carrier; headless profiles simply do not load this plugin. */
export const inject = ['webServer']

export async function apply(ctx: Context, config: AirRemoteHostConfigOverrides = {}): Promise<void> {
  const resolved = resolveHostConfig(config)
  const logger = ctx.logger('dsh-airremote')

  const discovery = new BoardDiscovery({ port: resolved.discoveryPort })
  try {
    await discovery.start()
  } catch (error) {
    logger.warn(
      `UDP discovery unavailable on ${String(resolved.discoveryPort)}: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  let fake: FakeBoard | undefined
  let simulation: { host: string; port: number } | undefined
  if (resolved.simulate) {
    fake = new FakeBoard({
      port: resolved.simPort,
      token: simulatedToken(resolved),
      wavPath: resolved.simWav,
      discoveryPort: resolved.discoveryPort
    })
    try {
      await fake.start()
      simulation = fake.address
      logger.info(`simulated board listening on ws://${simulation.host}:${String(simulation.port)}/voice`)
    } catch (error) {
      logger.error(`simulated board failed: ${error instanceof Error ? error.message : String(error)}`)
      fake = undefined
    }
  }

  const route = new AudioRoute({
    config: resolved,
    discovery,
    simulation,
    logger: (message) => logger.info(message)
  })
  const disposeRoute = ctx.webServer.registerUpgrade({ path: '/airremote/audio', handler: route.handler })

  /**
   * 开发板时间设置：GET/POST `/airremote/time` 读写时区偏好，
   * POST `/airremote/sync-time` 把 host 当前时间与时区写进板子。
   * 路由只是「有人点按钮才动」的普通 HTTP handler，不带定时器；
   * 注册失败（旧版 webserver 没有 `register`）只告警，不能让插件加载失败。
   */
  const serialHolder = new SerialHolder()
  const timeRoutes = new TimeRoutes({
    dataDir: resolved.dataDir,
    serialPort: resolved.serialPort,
    serialHolder,
    log: (message) => logger.info(message),
    warn: (message) => logger.warn(message)
  })
  const disposeTimeRoutes: (() => void)[] = []
  try {
    // 同一路径不能注册两次（webserver 对重复 (kind, path) 抛错），GET/POST 在 handler 里分发。
    disposeTimeRoutes.push(
      ctx.webServer.register({ kind: 'exact', path: '/airremote/time', handler: timeRoutes.timeHandler })
    )
    disposeTimeRoutes.push(
      ctx.webServer.register({ kind: 'exact', path: '/airremote/sync-time', handler: timeRoutes.syncTimeHandler })
    )
  } catch (error) {
    logger.warn(`board time routes unavailable: ${error instanceof Error ? error.message : String(error)}`)
    for (const dispose of disposeTimeRoutes.splice(0)) {
      try {
        dispose()
      } catch {
        /* 清理失败不影响插件 */
      }
    }
  }

  /**
   * 内置固件下发：`GET /airremote/firmware/manifest` + `GET /airremote/firmware/image`
   * （前端用 Web Serial 把镜像写进板子），以及串口锁 `/airremote/serial-state`、
   * `/airremote/serial-hold`。
   *
   * 固件文件是 `scripts/bundle-firmware.mjs` 在开发机生成的，运行时只读。
   * 缺失时只 `logger.error`（语音/时间功能必须还能用），相应路由回 503。
   */
  const firmwareRoutes = new FirmwareRoutes({
    firmwareDir: FIRMWARE_DIR,
    log: (message) => logger.info(message),
    warn: (message) => logger.warn(message)
  })
  for (const problem of await firmwareRoutes.selfCheck()) {
    logger.error(`airremote: ${problem.message}`)
  }

  const serialRoutes = new SerialRoutes({
    holder: serialHolder,
    log: (message) => logger.info(message),
    warn: (message) => logger.warn(message)
  })
  const disposeExtraRoutes: (() => void)[] = []
  const extraRoutes: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }[] = [
    { path: '/airremote/firmware/manifest', handler: firmwareRoutes.manifestHandler },
    { path: '/airremote/firmware/image', handler: firmwareRoutes.imageHandler },
    { path: '/airremote/serial-state', handler: serialRoutes.stateHandler },
    { path: '/airremote/serial-hold', handler: serialRoutes.holdHandler }
  ]
  try {
    for (const route of extraRoutes) {
      disposeExtraRoutes.push(ctx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }))
    }
  } catch (error) {
    logger.warn(`airremote firmware routes unavailable: ${error instanceof Error ? error.message : String(error)}`)
    for (const dispose of disposeExtraRoutes.splice(0)) {
      try {
        dispose()
      } catch {
        /* 清理失败不影响插件 */
      }
    }
  }

  /**
   * 烧录 upgrade 路由：`/airremote/flash`。
   * 浏览器点「烧录」→ 这里用 esptool-js + node-serialport 在**宿主进程**里烧内置镜像
   * （不再用 Web Serial），烧录期间持有 `flash` 串口锁，`/airremote/sync-time` 回 busy。
   * 注册失败（旧版 webserver 没有 `registerUpgrade`）只告警，不能让插件加载失败。
   */
  const flashRoute = new FlashRoute({
    firmwareDir: FIRMWARE_DIR,
    holder: serialHolder,
    resolvePort: () => findBoardPort(resolved.serialPort),
    logger: (message) => logger.info(message),
    warn: (message) => logger.warn(message)
  })
  let disposeFlashRoute: (() => void) | undefined
  try {
    disposeFlashRoute = ctx.webServer.registerUpgrade({ path: '/airremote/flash', handler: flashRoute.handler })
  } catch (error) {
    logger.warn(`flash route unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }

  let disposeTap: (() => void) | undefined
  try {
    const origin = ctx.webServer.getOrigin()
    const url = `${origin.replace(/^http/, 'ws')}/airremote/audio`
    const script = `<script>globalThis.__AIRREMOTE_AUDIO_URL__=${JSON.stringify(url).replaceAll('<', '\\u003c')}</script>`
    disposeTap = ctx.webServer.tapIndex((html) => html.replace(/<head(?:\s[^>]*)?>/i, (tag) => `${tag}${script}`))
  } catch (error) {
    logger.warn(`cannot inject the audio URL: ${error instanceof Error ? error.message : String(error)}`)
  }

  logger.info(
    `ready: board=${resolved.boardHost === '' ? 'discovery' : resolved.boardHost}:${String(resolved.boardPort)} ` +
      `simulate=${String(simulation !== undefined)} token=${resolved.pairingToken.length === 64 ? 'loaded' : 'missing'}`
  )

  ctx.effect(() => {
    return () => {
      disposeTap?.()
      disposeFlashRoute?.()
      disposeRoute()
      for (const dispose of disposeTimeRoutes) {
        try {
          dispose()
        } catch {
          /* 已经卸载过就算了 */
        }
      }
      for (const dispose of disposeExtraRoutes) {
        try {
          dispose()
        } catch {
          /* 已经卸载过就算了 */
        }
      }
      timeRoutes.dispose()
      route.dispose()
      flashRoute.dispose()
      fake?.stop()
      discovery.close()
    }
  }, 'dsh-airremote board audio bridge')
}
