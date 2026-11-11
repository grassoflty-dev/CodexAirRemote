import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { AudioRoute } from './host/audio-route.js'
import { BoardDiscovery } from './host/discovery.js'
import { FakeBoard } from './host/fake-board.js'
import { resolveHostConfig, simulatedToken, type AirRemoteHostConfigOverrides } from './host/config.js'
import { TimeRoutes } from './host/time-routes.js'

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
  const timeRoutes = new TimeRoutes({
    dataDir: resolved.dataDir,
    serialPort: resolved.serialPort,
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
      disposeRoute()
      for (const dispose of disposeTimeRoutes) {
        try {
          dispose()
        } catch {
          /* 已经卸载过就算了 */
        }
      }
      timeRoutes.dispose()
      route.dispose()
      fake?.stop()
      discovery.close()
    }
  }, 'dsh-airremote board audio bridge')
}
