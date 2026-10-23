/**
 * 平台识别与「重启计划」。
 *
 * 桌面版 DSH 是 Electron 应用，宿主进程只是它的子进程，所以重启必须在操作系统
 * 层面完成：先让整个应用退出，再重新打开。三个桌面平台的退出和重开方式不一样，
 * 这里把它们收敛成一份纯数据（plan），既方便测试，也方便用户在日志里对照。
 *
 * 这里的函数都不碰进程，只做判断和拼装；真正动手的是 lib/restart.js 生成的
 * 助手脚本。
 *
 * @module dsh-refresh-restart/lib/platform
 */

/** DeepSeek Harness 桌面版的 macOS bundle id，退出时按它找应用。 */
export const BUNDLE_ID = 'com.deepseek.dsh'

/** 从可执行文件路径反推 macOS .app 位置。 */
export function macAppPath(execPath) {
  if (typeof execPath !== 'string' || execPath === '') return ''
  const marker = '.app/Contents/MacOS/'
  const index = execPath.indexOf(marker)
  if (index === -1) return ''
  return execPath.slice(0, index + '.app'.length)
}

/** 取路径最后一段（同时兼容 Windows 的反斜杠）。 */
function baseName(value) {
  const parts = String(value).split(/[\\/]/)
  return parts[parts.length - 1] || ''
}

/**
 * 判断当前进程是不是「桌面应用本体」，并给出重启需要的路径。
 *
 * - macOS：从 `process.execPath` 里找 `.app/Contents/MacOS/`。
 * - Windows：可执行文件是 `.exe`，且不是 `node.exe` / `electron.exe`。
 * - Linux：优先用 AppImage 自带的 `APPIMAGE` 环境变量；否则只要 execPath 不是
 *   `node` / `electron` 这类运行时，就当成打包好的桌面程序。
 *   （CLI 模式下 execPath 是 node，不会被误判成可重启的桌面应用。）
 *
 * 用户可以用 `appPath` 配置覆盖自动识别（换过安装位置、Windows 绿色版等）。
 *
 * @param {{platform?: string, execPath?: string, appPath?: string, env?: Record<string, string | undefined>}} [input]
 */
export function detectApp(input = {}) {
  const platform = typeof input.platform === 'string' ? input.platform : process.platform
  const execPath = typeof input.execPath === 'string' ? input.execPath : process.execPath
  const env = input.env !== null && typeof input.env === 'object' ? input.env : process.env
  const override = typeof input.appPath === 'string' ? input.appPath.trim() : ''

  if (platform === 'darwin') {
    const resolved = override !== '' ? override : macAppPath(execPath)
    const isApp = resolved.endsWith('.app')
    return {
      platform,
      kind: isApp ? 'mac' : 'node',
      appPath: isApp ? resolved : '',
      execPath,
      imageName: baseName(execPath),
      canRestart: isApp,
    }
  }

  if (platform === 'win32') {
    const resolved = override !== '' ? override : execPath
    const name = baseName(resolved)
    const lower = name.toLowerCase()
    const isApp = lower.endsWith('.exe') && lower !== 'node.exe' && lower !== 'electron.exe'
    return {
      platform,
      kind: isApp ? 'win' : 'node',
      appPath: isApp ? resolved : '',
      execPath: resolved,
      imageName: name,
      canRestart: isApp,
    }
  }

  // Linux 及其它 unix：AppImage 会把自己的路径放进 APPIMAGE，退出后那条临时
  // 挂载路径就没了，所以必须用 APPIMAGE 重开。
  const appImage = typeof env?.APPIMAGE === 'string' ? env.APPIMAGE.trim() : ''
  const resolved = override !== '' ? override : appImage !== '' ? appImage : execPath
  const lower = baseName(resolved).toLowerCase()
  const runtime = lower === '' || lower === 'node' || lower === 'node.exe' || lower === 'electron' || lower === 'electron.exe'
  const isApp = !runtime
  return {
    platform,
    kind: isApp ? 'linux' : 'node',
    appPath: isApp ? resolved : '',
    execPath: resolved,
    imageName: baseName(resolved),
    canRestart: isApp,
  }
}

/**
 * 把「怎么退出、怎么重开」拍成一份计划，交给助手脚本执行。
 *
 * @param {ReturnType<typeof detectApp>} app
 * @param {{logPath: string, quitTimeoutMs?: number, openDelayMs?: number}} options
 */
export function buildPlan(app, { logPath, quitTimeoutMs = 20000, openDelayMs = 800 }) {
  const plan = {
    platform: app.platform,
    kind: app.kind,
    logPath,
    appPath: app.appPath,
    execPath: app.execPath,
    imageName: app.imageName,
    quitTimeoutMs,
    openDelayMs,
    quit: null,
    launch: null,
  }

  if (app.kind === 'mac') {
    plan.quit = { command: 'osascript', args: ['-e', `tell application id "${BUNDLE_ID}" to quit`] }
    // 只匹配这个 .app 里的进程，避免误伤别的应用。
    plan.match = `${app.appPath}/Contents/`
    plan.appId = BUNDLE_ID
    plan.launch = { type: 'open-app', path: app.appPath }
    return plan
  }

  if (app.kind === 'win') {
    const processName = app.imageName.replace(/\.exe$/i, '')
    plan.quit = {
      command: 'powershell',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }`,
      ],
    }
    plan.launch = { type: 'spawn-exe', path: app.appPath, cwd: app.appPath.replace(/[\\/][^\\/]+$/, '') }
    return plan
  }

  if (app.kind === 'linux') {
    // Linux 没有统一的「请应用退出」接口，直接发 SIGTERM，助手会再兜底 SIGKILL。
    plan.match = app.execPath
    plan.launch = { type: 'spawn-exe', path: app.execPath, cwd: app.execPath.replace(/[\\/][^\\/]+$/, '') }
    return plan
  }

  plan.launch = null
  return plan
}

/** 平台不支持时给页面看的原因，按平台分开说，方便排查。 */
export function unsupportedReason(platform) {
  if (platform === 'darwin') return '没找到 DSH 的 .app 位置，请用 appPath 配置填上应用路径'
  if (platform === 'win32') return '没找到 DSH 的可执行文件，请用 appPath 配置填上 exe 路径'
  if (platform === 'linux') return '没找到 DSH 的可执行文件，请用 appPath 配置填上程序路径'
  return '浏览器 / CLI 模式下没有可重启的桌面应用'
}

/**
 * 过滤出「可以传给新应用」的环境变量。
 *
 * 助手自己是靠 `ELECTRON_RUN_AS_NODE=1` 才跑起来的（借 Electron 的 Node 执行），
 * 而 macOS 的 `open` 会把调用者的环境原样交给新应用 —— 于是重开出来的「应用」也
 * 带着这个开关，Electron 按纯 Node 模式启动：进程在，窗口永远没有。用户看到的
 * 就是「关掉了，再也没打开」。所以重开之前必须把这几个开关摘掉。
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function relaunchEnv(env = process.env) {
  const cleaned = {}
  for (const key of Object.keys(env)) {
    if (key.indexOf('ELECTRON_') === 0) continue
    if (key === 'NODE_OPTIONS' || key === 'NODE_PATH') continue
    cleaned[key] = env[key]
  }
  return cleaned
}

/**
 * 生成助手脚本源码（CommonJS，交给 Electron 自带的 Node 运行）。
 *
 * 为什么不写成 shell 脚本：Windows 没有 bash；而把代码写成 Node，三个平台可以
 * 共用一套逻辑（扫描进程、等待、兜底强杀、重开）。执行它用的是
 * `process.execPath` + `ELECTRON_RUN_AS_NODE=1`，不需要用户装 Node。
 *
 * @param {ReturnType<typeof buildPlan>} plan
 */
export function helperSource(plan) {
  return `'use strict'
// dsh-refresh-restart 重启助手（由插件生成，放在临时目录，可随时删除）
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const plan = ${JSON.stringify(plan, null, 2)}

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

function log(message) {
  try {
    fs.appendFileSync(plan.logPath, '[' + stamp() + '] refresh-restart: ' + message + '\\n')
  } catch {
    // 日志写不进去也不影响重启
  }
}

// 重开应用时用的环境：摘掉 ELECTRON_* 这类「把 Electron 当 Node 用」的开关。
// 助手自己带着 ELECTRON_RUN_AS_NODE=1，若不摘掉，新进程会以纯 Node 模式启动，
// 进程在、窗口永远不出来 —— 这正是「重启后打不开」的真实原因。
const childEnv = (function () {
  const env = {}
  for (const key of Object.keys(process.env)) {
    if (key.indexOf('ELECTRON_') === 0) continue
    if (key === 'NODE_OPTIONS' || key === 'NODE_PATH') continue
    env[key] = process.env[key]
  }
  return env
})()

function run(command, args) {
  try {
    return spawnSync(command, args, { encoding: 'utf8', timeout: 20000, windowsHide: true, env: childEnv })
  } catch (error) {
    log('spawn 失败 ' + command + ': ' + error.message)
    return { status: -1, stdout: '', stderr: '' }
  }
}

function sleep(ms) {
  // 同步睡，助手是单线程的一次性脚本，没有并发需求
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** 扫描还活着的应用进程（排除助手自己）。 */
function appPids() {
  const pids = []
  if (plan.platform === 'win32') {
    const result = run('tasklist', ['/FI', 'IMAGENAME eq ' + plan.imageName, '/NH', '/FO', 'CSV'])
    const text = (result.stdout || '').trim()
    if (text === '' || /^INFO:/i.test(text)) return pids
    for (const line of text.split(/\\r?\\n/)) {
      const match = line.match(/^"([^"]+)","(\\d+)"/)
      if (match) pids.push(Number(match[2]))
    }
    return pids
  }

  const result = run('ps', ['-Ao', 'pid=,command='])
  const text = result.stdout || ''
  const needle = plan.match || plan.execPath
  for (const line of text.split('\\n')) {
    const match = line.match(/^\\s*(\\d+)\\s+(.*)$/)
    if (!match) continue
    const pid = Number(match[1])
    const command = match[2]
    if (pid === process.pid) continue
    if (needle !== '' && command.indexOf(needle) === -1) continue
    pids.push(pid)
  }
  return pids
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function signalAll(signal) {
  const pids = appPids()
  if (pids.length === 0) return 0
  for (const pid of pids) {
    try {
      process.kill(pid, signal)
    } catch {
      // 已经退出的进程会抛错，忽略
    }
  }
  return pids.length
}

function waitGone(ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (appPids().filter(alive).length === 0) return true
    sleep(250)
  }
  return appPids().filter(alive).length === 0
}

/** 等新应用真的起来（进程出现）。open 返回 0 只代表「请求发出去了」，不代表起来了。 */
function waitUp(ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (appPids().filter(alive).length > 0) return true
    sleep(250)
  }
  return appPids().filter(alive).length > 0
}

/**
 * 等「有窗口」的证据：Electron 开窗口一定会拉起带 --type=renderer 的渲染进程。
 * 只有进程、没有渲染进程，说明它是以 Node 模式跑起来的空壳（环境变量泄漏的旧症状）。
 * Windows 的 tasklist 看不到命令行参数，退回「进程在就算起来了」。
 */
function windowSeen(ms) {
  if (plan.platform === 'win32') return true
  const deadline = Date.now() + ms
  const scan = function () {
    const result = run('ps', ['-Ao', 'pid=,command='])
    const needle = plan.match || plan.execPath
    for (const line of result.stdout ? result.stdout.split('\\n') : []) {
      if (line.indexOf('--type=renderer') === -1) continue
      if (needle !== '' && line.indexOf(needle) === -1) continue
      return true
    }
    return false
  }
  while (Date.now() < deadline) {
    if (scan()) return true
    sleep(250)
  }
  return scan()
}

/** macOS 重开：先按路径，失败再按 bundle id 重试。 */
function openApp() {
  const first = run('open', ['-a', plan.launch.path])
  if (first.status === 0) return true
  log('open -a 失败: ' + (first.stderr || first.status))
  if (!plan.appId) return false
  const second = run('open', ['-b', plan.appId])
  if (second.status !== 0) {
    log('open -b 失败: ' + (second.stderr || second.status))
    return false
  }
  return true
}

function launch() {
  if (!plan.launch) return false
  try {
    if (plan.launch.type === 'open-app') {
      if (!openApp()) return false
      if (!waitUp(20000)) {
        log('open 之后 20 秒没看到进程，按 bundle id 再试一次')
        if (!openApp()) return false
        return waitUp(20000) && windowSeen(20000)
      }
      if (windowSeen(20000)) return true
      // 进程在、却没有渲染进程：以前正是 ELECTRON_RUN_AS_NODE 泄漏导致的样子。
      log('进程已启动但没有窗口（没看到 --type=renderer），按 bundle id 再 open 一次')
      if (plan.appId) run('open', ['-b', plan.appId])
      return windowSeen(15000)
    }
    const child = spawn(plan.launch.path, [], {
      detached: true,
      stdio: 'ignore',
      cwd: plan.launch.cwd || undefined,
      // 同样要带干净的环境，否则 Windows / Linux 上重开的也是「Node 模式的空壳」
      env: childEnv,
      windowsHide: false,
    })
    child.unref()
    return waitUp(20000)
  } catch (error) {
    log('重新打开失败: ' + error.message)
    return false
  }
}

function main() {
  log('helper start pid=' + process.pid + ' kind=' + plan.kind + ' platform=' + plan.platform)
  sleep(1000)

  if (plan.quit) {
    const result = run(plan.quit.command, plan.quit.args)
    log('quit 请求: ' + plan.quit.command + ' status=' + result.status)
  }

  if (waitGone(plan.quitTimeoutMs)) {
    log('应用已退出')
  } else {
    log('应用没有自己退出，发送 SIGTERM')
    signalAll('SIGTERM')
    if (!waitGone(10000)) {
      log('SIGTERM 无效，强制结束')
      if (plan.platform === 'win32') {
        run('taskkill', ['/F', '/T', '/IM', plan.imageName])
      } else {
        signalAll('SIGKILL')
      }
      sleep(500)
    } else {
      log('应用已退出（SIGTERM）')
    }
  }

  sleep(Math.max(0, plan.openDelayMs))
  log('重新打开 ' + (plan.launch ? plan.launch.path : '(无)'))
  const ok = launch()
  if (ok) {
    log('应用已重新打开')
  } else {
    log('重开失败：请手动打开 DSH' + (plan.launch ? '（' + plan.launch.path + '）' : ''))
  }
  log('helper done, launched=' + ok)
}

try {
  main()
} catch (error) {
  log('helper 异常: ' + (error && error.stack ? error.stack : String(error)))
}
`
}
