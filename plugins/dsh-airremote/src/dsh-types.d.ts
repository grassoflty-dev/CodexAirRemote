/**
 * Local type surface for the two DSH services this plugin touches but does not
 * depend on as npm packages at build time: the Web carrier (`webServer`) and the
 * client slot registry (`slots`). The runtime objects are provided by the DSH
 * installation; only the members used here are declared.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** `@deepseek-ai/dsh-host-webserver` (web profiles). */
    webServer: {
      getOrigin(): string
      tapIndex(transform: (html: string) => string): () => void
      /**
       * 普通 HTTP 路由。`exact` 精确匹配路径、`prefix` 最长前缀优先；
       * 匹配只按路径、不看方法，所以同一路径的多个方法要在一个 handler 里分发。
       * 重复注册同一个 (kind, path) 会抛错。
       */
      register(route: {
        kind: 'exact' | 'prefix'
        path: string
        handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
      }): () => void
      registerUpgrade(route: {
        path: string
        handler(req: IncomingMessage, socket: Duplex, head: Buffer): void | Promise<void>
      }): () => void
    }

    /** `@deepseek-ai/dsh-client-ui-renderer` slot registry (client bundle). */
    slots: {
      inject(name: string, callback: () => unknown): unknown
      register(options: Record<string, unknown>, component: unknown): () => void
    }

    /** Cordis effect registration; typed loosely here because the installed peer version differs. */
    effect(execute: () => void | (() => void), label?: string): unknown
  }
}
