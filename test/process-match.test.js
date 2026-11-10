/**
 * 回归测试：借应用二进制启动、却不属于应用的进程，不能被当成「DSH 还在跑」。
 *
 * 真实事故（2026-11-10）：Chrome 的浏览器桥原生消息宿主由
 * `~/.dsh/chrome-bridge/host/run.sh` 用 DSH 的二进制拉起，命令行开头同样是
 * `<appPath>/Contents/...`。DSH 退出后它还在，助手于是永远等不到「进程清空」，
 * 每次重启都白等满 20 秒、按「取消」作废，重开那一步根本没执行。
 *
 * 修法：宿主把应用主进程 pid 写进计划，助手只认「主进程 + 它的子孙」；拿不到
 * 主进程 pid 时退回命令行子串匹配，但排除 FOREIGN_RUNNER_MARKERS 里的进程。
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  FOREIGN_RUNNER_MARKERS,
  buildPlan,
  detectApp,
  helperSource,
  isForeignRunner,
  pickAppMainPid,
} from '../lib/platform.js'

const MAC_EXEC = '/Applications/DeepSeek.app/Contents/MacOS/DeepSeek Harness'
const BRIDGE_JS = '/Users/u/.dsh/chrome-bridge/host/host.js'

/** Windows 没有 ps / sh，端到端只在类 Unix 上跑；纯函数用例所有平台都跑。 */
const posixOnly = process.platform === 'win32' ? 'Windows 没有 ps / sh' : false

/** 一个能活 ms 毫秒的子进程，命令行里带上 marker。 */
function spawnSleeper(script, ms) {
  writeFileSync(script, `setTimeout(function () {}, ${ms})\n`)
  return spawn(process.execPath, [script], { stdio: 'ignore' })
}

function killQuietly(child) {
  try {
    child.kill('SIGKILL')
  } catch {
    // 已经退了
  }
}

test('isForeignRunner：浏览器桥算外来借用者，DSH 自己不算', () => {
  assert.deepEqual([...FOREIGN_RUNNER_MARKERS], ['chrome-bridge/host/host.js'])
  assert.equal(isForeignRunner(`${MAC_EXEC} ${BRIDGE_JS} chrome-extension://abc`), true)
  assert.equal(isForeignRunner(MAC_EXEC), false)
  assert.equal(isForeignRunner(''), false)
  assert.equal(isForeignRunner(undefined), false)
})

test('pickAppMainPid：沿 ppid 链爬到 .app 主进程，桥进程不在链上', () => {
  const entries = [
    { pid: 100, ppid: 1, command: MAC_EXEC },
    { pid: 200, ppid: 100, command: `${MAC_EXEC} --expose-internals host.js` },
    { pid: 300, ppid: 200, command: `${MAC_EXEC} --import preload.js` },
    // Chrome 拉起的桥：命令行也以 execPath 开头，但父进程不是主进程
    { pid: 400, ppid: 999, command: `${MAC_EXEC} ${BRIDGE_JS} chrome-extension://x` },
  ]
  assert.equal(pickAppMainPid({ hostPid: 300, execPath: MAC_EXEC, entries }), 100)
  // 宿主不在进程表里（ps 失败 / 进程已退出）：当作没解析出来
  assert.equal(pickAppMainPid({ hostPid: 999, execPath: MAC_EXEC, entries }), 0)
  // 链上出现命令行对不上的进程就停，不能一路爬到 launchd
  assert.equal(pickAppMainPid({ hostPid: 400, execPath: MAC_EXEC, entries }), 0)
})

test('buildPlan：主进程 pid 写进计划，非法值收敛成 0', () => {
  const app = detectApp({ platform: 'darwin', execPath: MAC_EXEC })
  assert.equal(buildPlan(app, { logPath: '/tmp/l.log' }).mainPid, 0)
  assert.equal(buildPlan(app, { logPath: '/tmp/l.log', mainPid: 28399 }).mainPid, 28399)
  assert.equal(buildPlan(app, { logPath: '/tmp/l.log', mainPid: -1 }).mainPid, 0)
  assert.equal(buildPlan(app, { logPath: '/tmp/l.log', mainPid: 'abc' }).mainPid, 0)
})

test('helperSource：按主进程 + 子孙判定，且内嵌外来进程标记', () => {
  const app = detectApp({ platform: 'darwin', execPath: MAC_EXEC })
  const source = helperSource(buildPlan(app, { logPath: '/tmp/l.log', mainPid: 28399 }))
  assert.match(source, /chrome-bridge\/host\/host\.js/)
  assert.match(source, /const appMainPid =/)
  assert.match(source, /isDescendantOf/)
  assert.match(source, /launchPids/)
  assert.match(source, /main=' \+ appMainPid/)
})

test('端到端：主进程退出后不再等浏览器桥宿主', { skip: posixOnly }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-refresh-restart-mainpid-'))
  const stub = join(dir, 'stub-mainpid.sh')
  writeFileSync(stub, '#!/bin/sh\nsleep 2.5\n')
  chmodSync(stub, 0o755)

  mkdirSync(join(dir, 'chrome-bridge', 'host'), { recursive: true })
  const decoy = spawnSleeper(join(dir, 'chrome-bridge', 'host', 'host.js'), 5000)
  const main = spawn('sh', [stub], { stdio: 'ignore' })

  const logPath = join(dir, 'helper.log')
  const plan = {
    platform: 'darwin',
    kind: 'mac',
    logPath,
    appPath: dir,
    execPath: dir,
    imageName: 'stub-mainpid.sh',
    quitTimeoutMs: 6000,
    openDelayMs: 0,
    statePath: join(dir, 'state.json'),
    forceKill: false,
    mainPid: main.pid,
    // 桥和假应用都命中这个子串：判定只能靠「主进程 + 子孙」，不能靠子串
    match: dir,
    quit: null,
    launch: null,
  }
  const script = join(dir, 'helper.cjs')
  writeFileSync(script, helperSource(plan))

  try {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 20000 })
    assert.equal(result.status, 0, result.stderr)
    const log = readFileSync(logPath, 'utf8')
    assert.match(log, /main=/, '助手日志里要记下盯着的主进程 pid')
    assert.match(log, /应用已退出/)
    assert.doesNotMatch(log, /没有退出/)
    // 桥进程既没被当成应用，也没被顺手杀掉
    assert.equal(spawnSync('kill', ['-0', String(decoy.pid)]).status, 0, '桥进程不该被杀')
  } finally {
    killQuietly(main)
    killQuietly(decoy)
  }
})

test('端到端：没解析出主进程 pid 时，退回子串匹配也要排除桥进程', { skip: posixOnly }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-refresh-restart-fallback-'))
  const stub = join(dir, 'stub-mainpid.sh')
  writeFileSync(stub, '#!/bin/sh\nsleep 2.5\n')
  chmodSync(stub, 0o755)

  mkdirSync(join(dir, 'chrome-bridge', 'host'), { recursive: true })
  const decoy = spawnSleeper(join(dir, 'chrome-bridge', 'host', 'host.js'), 5000)
  const main = spawn('sh', [stub], { stdio: 'ignore' })

  const logPath = join(dir, 'helper.log')
  const plan = {
    platform: 'darwin',
    kind: 'mac',
    logPath,
    appPath: dir,
    execPath: dir,
    imageName: 'stub-mainpid.sh',
    quitTimeoutMs: 6000,
    openDelayMs: 0,
    statePath: join(dir, 'state.json'),
    forceKill: false,
    // 故意不给主进程 pid：走子串匹配，桥进程必须被 FOREIGN_MARKERS 挡掉
    mainPid: 0,
    match: dir,
    quit: null,
    launch: null,
  }
  const script = join(dir, 'helper.cjs')
  writeFileSync(script, helperSource(plan))

  try {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 20000 })
    assert.equal(result.status, 0, result.stderr)
    const log = readFileSync(logPath, 'utf8')
    assert.match(log, /应用已退出/)
    assert.doesNotMatch(log, /没有退出/)
    assert.equal(spawnSync('kill', ['-0', String(decoy.pid)]).status, 0, '桥进程不该被杀')
  } finally {
    killQuietly(main)
    killQuietly(decoy)
  }
})