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
 * macOS / Linux 的助手是 CommonJS，用 `process.execPath` 加 `ELECTRON_RUN_AS_NODE=1`
 * 执行：借 Electron 自带的 Node，用户不用另外装 Node。
 *
 * Windows 不一样，见 lib/win.js：桌面版的主进程被放在带 kill-on-close 的 job
 * object 里，从里面 spawn 出来的 detach 进程会跟着应用一起被回收 —— 只关不开的
 * 根因。那边改用 PowerShell 助手，并且借 explorer.exe 的手启动它（Explorer 在
 * job object 之外），再把应用重开。
 *
 * @module dsh-refresh-restart/lib/restart
 */

import { spawn } from 'node:child_process'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { buildPlan, detectApp, helperSource, unsupportedReason } from './platform.js'
import { WIN_HELPER_PATH, dispatchWin } from './win.js'

/** 所有路由的前缀，与 lib/routes.js 保持一致。 */
export const ROUTE_PREFIX = '/plugins/dsh-refresh-restart'

/** 配置键的默认值 —— 无论 Schemastery 是否可用都走这里。 */
export const DEFAULTS = {
  quitTimeoutMs: 20000,
  openDelayMs: 800,
  appPath: '',
  forceKill: false,
}

/** 助手把进度写到这个文件，界面靠它判断「到底关没关」。 */
export const STATE_FILE = join(tmpdir(), 'dsh-refresh-restart-state.json')

/** 读助手写的进度；读不到就当没有。 */
export function readState(file = STATE_FILE) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 这次重启是不是已经结束了（助手报告取消 / 开不起来）。
 *
 * 界面靠 `running` 判断按钮能不能点。助手是在宿主之外跑的，它决定收工时宿主
 * 并不知道 —— 不把标志放开，按钮会永远停在「已经在重启了」。
 */
export function busyHeld(running, state) {
  if (running !== true) return false
  if (state === null || typeof state !== 'object') return true
  return !(state.phase === 'cancelled' || state.phase === 'launch-failed')
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
    forceKill: source.forceKill === true,
  }
}

/** 时间戳，只用于文件名。 */
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

/** 宿主侧写状态（助手启动后会用自己写的覆盖）。 */
function writeStateFile(payload, file = STATE_FILE) {
  try {
    writeFileSync(file, JSON.stringify(payload), 'utf8')
  } catch {
    // 写不进去不影响重启，界面会退化成「看不到进度」
  }
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
      const state = readState()
      running = busyHeld(running, state)
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
        state,
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
        statePath: STATE_FILE,
        quitTimeoutMs: settings.quitTimeoutMs,
        openDelayMs: settings.openDelayMs,
        forceKill: settings.forceKill,
      })
      // 先写一条「已收到重启请求」：用户在 1 秒内就能看到界面进入「正在关闭」，
      // 而不是空白等待助手那 1 秒的启动延迟。
      writeStateFile({ phase: 'requested', detail: '', at: Date.now() })

      // Windows 走另一条路：PowerShell 助手 + explorer 交接（见 lib/win.js）。
      if (process.platform === 'win32') {
        const hand = dispatchWin({ plan, stamp: name, logger })
        if (!hand.ok) {
          writeStateFile({ phase: 'launch-failed', detail: hand.error, at: Date.now() })
          const failure = new Error(`没能在 Windows 上拉起重启助手：${hand.error}`)
          failure.code = 'spawn-failed'
          throw failure
        }
        running = true
        last = {
          at: Date.now(),
          logPath,
          scriptPath: WIN_HELPER_PATH,
          helperPid: hand.helperPid,
          kind: app.kind,
          strategy: hand.mode,
          warning: hand.warning || '',
        }
        logger(`重启中：Windows 助手 pid ${last.helperPid}（${hand.mode}），日志 ${logPath}`)
        return { ok: true, ...last }
      }

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
