/**
 * 回归测试：重开应用时不能把 ELECTRON_RUN_AS_NODE 之类的开关带过去。
 *
 * 真实事故（2026-10-23）：助手是靠 ELECTRON_RUN_AS_NODE=1 跑起来的，macOS 的
 * `open` 会把调用者环境原样交给新应用，于是重开出来的「应用」按纯 Node 模式启动
 * —— 进程在、窗口没有，用户看到的是「关掉了，再也没打开」。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildPlan, detectApp, helperSource, relaunchEnv } from '../lib/platform.js'

const MAC_EXEC = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'

test('relaunchEnv 摘掉 Electron 开关，其它变量原样保留', () => {
  const cleaned = relaunchEnv({
    PATH: '/usr/bin:/bin',
    HOME: '/Users/example',
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_ENABLE_LOGGING: '1',
    NODE_OPTIONS: '--max-old-space-size=4096',
    NODE_PATH: '/tmp/x',
  })
  assert.deepEqual(cleaned, { PATH: '/usr/bin:/bin', HOME: '/Users/example' })
})

test('macOS 计划里带上 bundle id，供 open -b 兜底', () => {
  const plan = buildPlan(detectApp({ platform: 'darwin', execPath: MAC_EXEC }), { logPath: '/tmp/l.log' })
  assert.equal(plan.appId, 'com.deepseek.dsh')
  assert.equal(plan.launch.type, 'open-app')
})

test('助手源码里有环境清洗、进程校验与 bundle id 兜底', () => {
  const source = helperSource(buildPlan(detectApp({ platform: 'darwin', execPath: MAC_EXEC }), { logPath: '/tmp/l.log' }))
  assert.match(source, /ELECTRON_/)
  assert.match(source, /childEnv/)
  assert.match(source, /waitUp/)
  assert.match(source, /'-b'/)
  assert.match(source, /应用已重新打开/)
})

// Windows 的 runner 没有 /bin/sh，写不出这个替身脚本；环境清洗逻辑本身在
// 上面两条（relaunchEnv + 助手源码）已经覆盖，端到端只在类 Unix 上跑。
const windowsSkip = process.platform === 'win32' ? 'Windows 没有 /bin/sh 替身脚本' : false

test('端到端：助手拉起的子进程拿不到 ELECTRON_RUN_AS_NODE', { skip: windowsSkip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-refresh-restart-env-'))
  const out = join(dir, 'env.txt')
  const stub = join(dir, 'stub-app.sh')
  writeFileSync(stub, `#!/bin/sh\nenv > "${out}"\nsleep 1\n`)
  chmodSync(stub, 0o755)

  const plan = {
    platform: 'darwin',
    kind: 'mac',
    logPath: join(dir, 'helper.log'),
    appPath: '',
    execPath: stub,
    imageName: 'stub-app.sh',
    quitTimeoutMs: 1000,
    openDelayMs: 0,
    quit: null,
    // 只匹配这个 stub 自己的文件名，不会误伤真进程；stub 活 1 秒，waitUp 能立刻看到
    match: 'stub-app.sh',
    appId: '',
    launch: { type: 'spawn-exe', path: stub, cwd: dir },
  }
  const script = join(dir, 'helper.cjs')
  writeFileSync(script, helperSource(plan))

  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_ENABLE_LOGGING: '1' },
  })
  assert.equal(result.status, 0, result.stderr)

  // 助手确认进程起来后就退出了，stub 还在写文件，所以要等它一下
  const deadline = Date.now() + 5000
  // 文件是先创建后写入，所以不能只看存在：一直读到内容齐了为止，避免读到空文件
  let dumped = ''
  while (Date.now() < deadline) {
    if (existsSync(out)) {
      dumped = readFileSync(out, 'utf8')
      if (/^PATH=/m.test(dumped)) break
    }
    spawnSync('sleep', ['0.05'])
  }

  assert.ok(dumped !== '', '子进程没有把环境写出来')
  assert.doesNotMatch(dumped, /^ELECTRON_RUN_AS_NODE=/m, 'ELECTRON_RUN_AS_NODE 漏进了新应用')
  assert.doesNotMatch(dumped, /^ELECTRON_ENABLE_LOGGING=/m, 'ELECTRON_* 前缀没被全部摘掉')
  assert.match(dumped, /^PATH=/m, 'PATH 这类必要变量不该被删')
  assert.doesNotMatch(dumped, /^NODE_OPTIONS=/m)
})
