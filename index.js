/**
 * dsh-refresh-restart — host half.
 *
 * 本包自己就是插件模块：这里导出 Schemastery `Config`（让 cordis.patch.yml
 * 里的那一行可以独立配置）和一个 `apply`，把两件事接起来：
 *
 *   1. `lib/restart.js` —— 生成并启动一个脱离宿主的 shell 助手：
 *      先让应用自己退出，再重新打开；
 *   2. `lib/routes.js` —— 页面上的按钮通过同源 HTTP 路由访问它。
 *
 * 刷新按钮不需要宿主配合（页面自己 `location.reload()`），这里只提供重启。
 *
 * @module dsh-refresh-restart
 */

import { randomBytes } from 'node:crypto'
import { registerRoutes } from './lib/routes.js'
import { createRestartService } from './lib/restart.js'

/**
 * Schemastery 是每个 bundle 的 peer dependency，但用目录 link 安装时 Node 按
 * 真实路径解析 ESM，这个 import 可能失败。动态加载，失败时把 schema 置空，
 * `lib/restart.js` 的 normalizeConfig() 仍然会给每个键兜默认值并做校验，
 * 插件功能不受影响。
 */
let Schema = null
try {
  Schema = (await import('@deepseek-ai/schemastery')).default
} catch {
  Schema = null
}

/** 配置模板 —— 与 bundle patch 里写的键一一对应。 */
export const Config = Schema === null
  ? undefined
  : Schema.object({
      quitTimeoutMs: Schema.number()
        .default(20000)
        .description('「重启」后等待应用自己退出的最长时间（毫秒）。超时就当我这次重启作废，不动进程。'),
      openDelayMs: Schema.number()
        .default(800)
        .description('确认退出后，隔多久重新打开应用（毫秒）。'),
      appPath: Schema.string()
        .default('')
        .description('应用位置；留空表示自动识别当前运行的 .app。'),
      forceKill: Schema.boolean()
        .default(false)
        .description('超时后是否强杀应用。默认关闭：用户点了「取消」就放弃本次重启，不强杀也不重开。'),
    })

/**
 * 兼容各种形状的 logger：宿主不一定提供 logger 服务，消费者调用方式也不统一，
 * 所以逐个形状试，最后退回 console。
 */
function makeLogger(ctx) {
  return (message) => {
    const text = String(message)
    try {
      const logger = ctx.logger
      if (typeof logger === 'function') {
        const scoped = logger('dsh-refresh-restart')
        if (scoped !== undefined && typeof scoped?.info === 'function') {
          scoped.info(text)
          return
        }
        if (scoped !== undefined && typeof scoped === 'function') {
          scoped(text)
          return
        }
      }
      if (typeof logger?.info === 'function') {
        logger.info(text)
        return
      }
    } catch {
      // 落到 console
    }
    console.log(`[dsh-refresh-restart] ${text}`)
  }
}

/**
 * 插件入口。
 *
 * @param {import('cordis').Context} ctx
 * @param {object} config bundle patch 里给的设置。
 */
export function apply(ctx, config) {
  const logger = makeLogger(ctx)
  const service = createRestartService({ config, logger })

  // 别的插件 / 检查器可以复用同一份状态，而不是再起一个。
  try {
    if (typeof ctx.set === 'function') ctx.set('refreshRestart', service)
  } catch (error) {
    logger(`无法注册 refreshRestart 服务：${error instanceof Error ? error.message : String(error)}`)
  }

  // 路由需要宿主的 webServer。用 ctx.inject 注册，宿主没带 webServer 时本插件
  // 依然能加载，只是按钮永远拿不到状态。
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (webCtx) => {
        registerRoutes(webCtx, service, { logger })
      })
    } else {
      registerRoutes(ctx, service, { logger })
    }
  } catch (error) {
    logger(`注册快捷动作路由失败：${error instanceof Error ? error.message : String(error)}`)
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => service.dispose(), 'dsh-refresh-restart: dispose service')
  }

  const snapshot = service.snapshot()
  logger(
    `已就绪：${snapshot.canRestart ? `可重启（${snapshot.appPath}）` : '当前平台/启动方式不支持重启'}，路由前缀 ${snapshot.routePrefix}`,
  )
}
