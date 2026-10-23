/**
 * 平台识别、重启计划与助手脚本的回归测试。
 *
 *   node --test test/
 *
 * 这里刻意不碰真实进程：检测和计划都是纯函数，Windows / Linux 分支也能在 macOS
 * 上断言。真正执行放在用户点按钮时。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { BUNDLE_ID, buildPlan, detectApp, helperSource, macAppPath, unsupportedReason } from '../lib/platform.js'
import { DEFAULTS, normalizeConfig } from '../lib/restart.js'

const MAC_EXEC = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
const WIN_EXEC = 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe'

test('macAppPath 只认 .app/Contents/MacOS/', () => {
  assert.equal(macAppPath(MAC_EXEC), '/Applications/DeepSeek Harness.app')
  assert.equal(macAppPath('/usr/local/bin/node'), '')
  assert.equal(macAppPath(''), '')
})

test('detectApp：macOS 桌面版可重启', () => {
  const app = detectApp({ platform: 'darwin', execPath: MAC_EXEC, appPath: '' })
  assert.equal(app.kind, 'mac')
  assert.equal(app.canRestart, true)
  assert.equal(app.appPath, '/Applications/DeepSeek Harness.app')
})

test('detectApp：macOS 下用 node 跑就不支持', () => {
  const app = detectApp({ platform: 'darwin', execPath: '/opt/homebrew/bin/node', appPath: '' })
  assert.equal(app.kind, 'node')
  assert.equal(app.canRestart, false)
})

test('detectApp：Windows 桌面版可重启，node/electron 不行', () => {
  const win = detectApp({ platform: 'win32', execPath: WIN_EXEC, appPath: '' })
  assert.equal(win.kind, 'win')
  assert.equal(win.canRestart, true)
  assert.equal(win.imageName, 'DeepSeek Harness.exe')

  assert.equal(detectApp({ platform: 'win32', execPath: 'C:\\nodejs\\node.exe' }).canRestart, false)
  assert.equal(detectApp({ platform: 'win32', execPath: 'C:\\dev\\electron.exe' }).canRestart, false)
})

test('detectApp：Windows 绿色版用 appPath 覆盖', () => {
  const app = detectApp({ platform: 'win32', execPath: 'C:\\nodejs\\node.exe', appPath: 'D:\\Apps\\DSH\\dsh.exe' })
  assert.equal(app.kind, 'win')
  assert.equal(app.canRestart, true)
  assert.equal(app.appPath, 'D:\\Apps\\DSH\\dsh.exe')
})

test('detectApp：Linux 优先用 APPIMAGE 重启', () => {
  const app = detectApp({
    platform: 'linux',
    execPath: '/tmp/.mount_DSHabc/dsh',
    appPath: '',
    env: { APPIMAGE: '/home/u/Applications/DSH.AppImage' },
  })
  assert.equal(app.kind, 'linux')
  assert.equal(app.canRestart, true)
  assert.equal(app.appPath, '/home/u/Applications/DSH.AppImage')

  assert.equal(detectApp({ platform: 'linux', execPath: '/usr/bin/dsh' }).canRestart, true)
  assert.equal(detectApp({ platform: 'linux', execPath: '/usr/bin/node' }).canRestart, false)
  assert.equal(detectApp({ platform: 'linux', execPath: '/opt/electron/electron' }).canRestart, false)
})

test('buildPlan（macOS）：osascript 退出 + open 重开', () => {
  const plan = buildPlan(detectApp({ platform: 'darwin', execPath: MAC_EXEC }), { logPath: '/tmp/l.log' })
  assert.equal(plan.quit.command, 'osascript')
  assert.deepEqual(plan.quit.args, ['-e', `tell application id "${BUNDLE_ID}" to quit`])
  assert.equal(plan.match, '/Applications/DeepSeek Harness.app/Contents/')
  assert.deepEqual(plan.launch, { type: 'open-app', path: '/Applications/DeepSeek Harness.app' })
  assert.equal(plan.quitTimeoutMs, 20000)
})

test('buildPlan（Windows）：CloseMainWindow 退出 + 直接拉起 exe', () => {
  const app = detectApp({ platform: 'win32', execPath: WIN_EXEC })
  const plan = buildPlan(app, { logPath: '/tmp/l.log', quitTimeoutMs: 5000, openDelayMs: 0 })
  assert.equal(plan.quit.command, 'powershell')
  const script = plan.quit.args.at(-1)
  assert.match(script, /Get-Process -Name 'DeepSeek Harness'/)
  assert.match(script, /CloseMainWindow/)
  assert.deepEqual(plan.launch, {
    type: 'spawn-exe',
    path: WIN_EXEC,
    cwd: 'C:\\Program Files\\DeepSeek Harness',
  })
  assert.equal(plan.quitTimeoutMs, 5000)
  assert.equal(plan.openDelayMs, 0)
})

test('buildPlan（Linux）：没有 quit 命令，靠信号 + execPath 重开', () => {
  const app = detectApp({ platform: 'linux', execPath: '/opt/dsh/dsh', appPath: '', env: {} })
  const plan = buildPlan(app, { logPath: '/tmp/l.log' })
  assert.equal(plan.quit, null)
  assert.equal(plan.match, '/opt/dsh/dsh')
  assert.deepEqual(plan.launch, { type: 'spawn-exe', path: '/opt/dsh/dsh', cwd: '/opt/dsh' })
})

test('helperSource 是语法正确的 CJS，并内嵌可解析的 plan', () => {
  const plan = buildPlan(detectApp({ platform: 'win32', execPath: WIN_EXEC }), { logPath: '/tmp/l.log' })
  const source = helperSource(plan)
  assert.doesNotThrow(() => new Function(source))
  const start = source.indexOf('const plan = ') + 'const plan = '.length
  const end = source.indexOf('\n\nfunction stamp')
  const embedded = JSON.parse(source.slice(start, end))
  assert.equal(embedded.execPath, WIN_EXEC)
  assert.equal(embedded.kind, 'win')
})

test('helperSource 覆盖三个平台的关键动作', () => {
  const mac = helperSource(buildPlan(detectApp({ platform: 'darwin', execPath: MAC_EXEC }), { logPath: '/tmp/l' }))
  assert.match(mac, /spawnSync/)
  assert.match(mac, /SIGKILL/)
  assert.match(mac, /Atomics\.wait/)
  // 扫描进程时排除助手自己，否则会把自己杀掉
  assert.match(mac, /pid === process\.pid/)

  const win = helperSource(buildPlan(detectApp({ platform: 'win32', execPath: WIN_EXEC }), { logPath: '/tmp/l' }))
  assert.match(win, /tasklist/)
  assert.match(win, /taskkill/)
  assert.match(win, /CloseMainWindow/)
  assert.match(win, /windowsHide/)
})

test('unsupportedReason 按平台给不同原因', () => {
  assert.match(unsupportedReason('darwin'), /appPath/)
  assert.match(unsupportedReason('win32'), /exe/)
  assert.match(unsupportedReason('linux'), /程序路径/)
  assert.match(unsupportedReason('freebsd'), /浏览器/)
})

test('normalizeConfig 缺省与收敛', () => {
  assert.deepEqual(normalizeConfig(undefined), DEFAULTS)
  assert.deepEqual(normalizeConfig(null), DEFAULTS)
  assert.deepEqual(normalizeConfig({ quitTimeoutMs: 5000, openDelayMs: 0, appPath: '  /A B.app  ' }), {
    quitTimeoutMs: 5000,
    openDelayMs: 0,
    appPath: '/A B.app',
  })
  assert.equal(normalizeConfig({ quitTimeoutMs: 1 }).quitTimeoutMs, 1000)
  assert.equal(normalizeConfig({ quitTimeoutMs: 9e9 }).quitTimeoutMs, 300000)
  assert.equal(normalizeConfig({ quitTimeoutMs: 'abc' }).quitTimeoutMs, DEFAULTS.quitTimeoutMs)
  assert.equal(normalizeConfig({ openDelayMs: -1 }).openDelayMs, 0)
  assert.equal(normalizeConfig({ openDelayMs: 1e9 }).openDelayMs, 60000)
  assert.equal(normalizeConfig({ appPath: 42 }).appPath, '')
})
