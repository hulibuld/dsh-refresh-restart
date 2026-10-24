import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildPlan, detectApp, helperSource } from '../lib/platform.js'
import { readState } from '../lib/restart.js'

const MAC_EXEC = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'

test('readState：缺文件 / 坏 JSON 都当没有，正常内容原样解析', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rr-state-'))
  assert.equal(readState(join(dir, 'missing.json')), null)

  const broken = join(dir, 'broken.json')
  writeFileSync(broken, '{not json', 'utf8')
  assert.equal(readState(broken), null)

  const good = join(dir, 'good.json')
  writeFileSync(good, JSON.stringify({ phase: 'cancelled', at: 1 }), 'utf8')
  assert.deepEqual(readState(good), { phase: 'cancelled', at: 1 })
})

test('用户取消关闭时：助手不强杀、不重开，写出 cancelled 就收工', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rr-cancel-'))
  const logPath = join(dir, 'helper.log')
  const statePath = join(dir, 'state.json')

  const plan = buildPlan(detectApp({ platform: process.platform, execPath: MAC_EXEC }), {
    logPath,
    statePath,
    quitTimeoutMs: 700,
    openDelayMs: 0,
  })
  // 造一个「应用一直不退出」的局面：起一个活着的进程，并让进程扫描认得它。
  plan.quit = { command: '/bin/sh', args: ['-c', 'sleep 25 >/dev/null 2>&1 & exit 0'] }
  plan.match = 'sleep 25'
  // 万一逻辑写错走到重开，也别真把应用打开
  plan.launch = null

  try {
    const result = spawnSync(process.execPath, ['-e', helperSource(plan)], { encoding: 'utf8', timeout: 25000 })
    assert.equal(result.status, 0, result.stderr || '')

    // 1) 状态：取消，而不是 relaunched / launch-failed
    assert.equal(readState(statePath)?.phase, 'cancelled')

    // 2) 日志：明确放弃，且没有 SIGTERM / SIGKILL 这类补刀
    const log = readFileSync(logPath, 'utf8')
    assert.match(log, /本次重启作废/)
    assert.doesNotMatch(log, /SIGTERM/)
    assert.doesNotMatch(log, /SIGKILL/)
    assert.doesNotMatch(log, /重新打开/)

    // 3) 那个「还活着的应用」没有被杀
    const scan = spawnSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' })
    assert.match(scan.stdout || '', /sleep 25/)
  } finally {
    spawnSync('pkill', ['-f', 'sleep 25'])
  }
})

test('forceKill=true 时才允许强杀（配置项默认关闭）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rr-force-'))
  const plan = buildPlan(detectApp({ platform: process.platform, execPath: MAC_EXEC }), {
    logPath: join(dir, 'helper.log'),
    statePath: join(dir, 'state.json'),
    quitTimeoutMs: 500,
    openDelayMs: 0,
    forceKill: true,
  })
  assert.equal(plan.forceKill, true)

  const source = helperSource(plan)
  // 强杀分支被 forceKill 守着，不是无条件执行的
  assert.match(source, /else if \(plan\.forceKill\)/)
  assert.match(source, /按配置强杀/)
  assert.ok(existsSync(join(dir, 'helper.log')) === false)
})
