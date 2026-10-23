/**
 * 重启实现（macOS / Windows / Linux 桌面版）。
 *
 * 桌面版 DSH 是 Electron 应用：主进程退掉 = 整个应用消失，宿主进程只是它的
 * 子进程。所以「重启」只能从操作系统层面做，顺序是：
 *
 *   1. 拉起一个**脱离宿主**的助手进程（detached，宿主被杀它也不死）；
 *   2. 助手先请应用自己退出（macOS 用 osascript，Windows 用窗口句柄
 *      CloseMainWindow，Linux 直接 SIGTERM）；
 *   3. 等进程真的消失；超时依次升级到 SIGTERM / SIGKILL / taskkill /F；
 *   4. 隔一小会儿把同一个应用重新打开。
 *
 * 为什么不在插件里直接 `process.exit()`：宿主退出后窗口还在，Electron 主进程
 * 不会重新拉起宿主，界面就成了一具空壳。必须整个应用重开。
 *
 * 助手脚本是 CommonJS，用 `process.execPath` 加 `ELECTRON_RUN_AS_NODE=1` 执行：
 * 借 Electron 自带的 Node，用户不用另外装 Node，三个平台共用一套逻辑。
 *
 * @module dsh-refresh-restart/lib/restart
 */

import { spawn } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { buildPlan, detectApp, helperSource, unsupportedReason } from './platform.js'

/** 所有路由的前缀，与 lib/routes.js 保持一致。 */
export const ROUTE_PREFIX = '/plugins/dsh-refresh-restart'

/** 配置键的默认值 —— 无论 Schemastery 是否可用都走这里。 */
export const DEFAULTS = {
  quitTimeoutMs: 20000,
  openDelayMs: 800,
  appPath: '',
}

/** 把外部传入的 config 收敛成可靠的数字/字符串。 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const clamp = (value, fallback, min, max) => {
    const number = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(number)) return fallback
    return Math.min(max, Math.max(min, Math.round(number)))
  }
  return {
    quitTimeoutMs: clamp(source.quitTimeoutMs, DEFAULTS.quitTimeoutMs, 1000, 300000),
    openDelayMs: clamp(source.openDelayMs, DEFAULTS.openDelayMs, 0, 60000),
    appPath: typeof source.appPath === 'string' ? source.appPath.trim() : DEFAULTS.appPath,
  }
}

/** 时间戳，只用于文件名。 */
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

/**
 * 创建重启服务：持有 action token、负责真正拉起助手，并给 status 路由提供快照。
 *
 * @param {{config?: object, logger?: (message: string) => void}} options
 */
export function createRestartService({ config, logger = () => {} } = {}) {
  const settings = normalizeConfig(config)
  const token = randomBytes(16).toString('hex')
  const hostPid = typeof process.pid === 'number' ? process.pid : 0
  const execPath = typeof process.execPath === 'string' ? process.execPath : ''
  const app = detectApp({ platform: process.platform, execPath, appPath: settings.appPath, env: process.env })
  const canRestart = app.canRestart
  const environment = typeof process.env?.DSH_CLIENT_VERSION === 'string' ? process.env.DSH_CLIENT_VERSION : ''
  let last = null
  let running = false
  let disposed = false

  const service = {
    token,
    routePrefix: ROUTE_PREFIX,

    snapshot() {
      return {
        ok: true,
        platform: process.platform,
        kind: app.kind,
        appPath: app.appPath,
        imageName: app.imageName,
        canRestart,
        // 不支持时把原因带上，页面原样显示，不用自己猜。
        reason: canRestart ? '' : unsupportedReason(process.platform),
        running,
        token,
        hostPid,
        version: environment,
        settings: {
          quitTimeoutMs: settings.quitTimeoutMs,
          openDelayMs: settings.openDelayMs,
        },
        last,
      }
    },

    /**
     * 启动助手并立刻返回 —— HTTP 响应必须在应用退出之前发出去。
     *
     * @returns {{ ok: true, helperPid: number, logPath: string, scriptPath: string }}
     */
    restart() {
      if (disposed) {
        const error = new Error('插件已经被卸载了')
        error.code = 'disposed'
        throw error
      }
      if (running) {
        const error = new Error('已经在重启了')
        error.code = 'busy'
        throw error
      }
      if (!canRestart) {
        const error = new Error(unsupportedReason(process.platform))
        error.code = 'unsupported'
        throw error
      }
      if (execPath === '') {
        const error = new Error('拿不到当前进程的可执行文件路径，无法重启')
        error.code = 'unsupported'
        throw error
      }

      const name = `dsh-refresh-restart-${stamp()}`
      const logPath = join(tmpdir(), `${name}.log`)
      const scriptPath = join(tmpdir(), `${name}.cjs`)
      const plan = buildPlan(app, {
        logPath,
        quitTimeoutMs: settings.quitTimeoutMs,
        openDelayMs: settings.openDelayMs,
      })
      writeFileSync(scriptPath, helperSource(plan), { mode: 0o700 })
      try {
        chmodSync(scriptPath, 0o700)
      } catch {
        // 已经带 mode，失败也无所谓
      }

      const child = spawn(execPath, [scriptPath], {
        detached: true,
        stdio: 'ignore',
        // 借 Electron 自带的 Node 运行助手；普通 node 进程下这个变量无副作用。
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
      child.unref()
      running = true
      last = {
        at: Date.now(),
        logPath,
        scriptPath,
        helperPid: typeof child.pid === 'number' ? child.pid : 0,
        kind: app.kind,
      }
      logger(`重启中：助手 pid ${last.helperPid}，日志 ${logPath}`)
      return { ok: true, ...last }
    },

    dispose() {
      disposed = true
    },
  }

  return service
}
