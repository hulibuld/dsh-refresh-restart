import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  WIN_HELPER_PATH,
  buildPayload,
  helperArguments,
  powershellPath,
  psQuote,
  shortcutScript,
  waitBoot,
  winHelperSource,
} from '../lib/win.js'

const { join } = await import('node:path')

const isAscii = (text) => [...text].every((char) => char.codePointAt(0) <= 127)

test('win-helper.ps1 存在且是纯 ASCII', () => {
  const source = winHelperSource()
  assert.ok(source.length > 2000, `助手脚本太短：${source.length}`)
  // Windows PowerShell 5.1 用 ANSI 解码无 BOM 的 UTF-8；脚本里一旦有中文，
  // 解析就会因为引号错位而失败。这条断言就是防止以后有人加中文注释。
  assert.ok(isAscii(source), 'win-helper.ps1 里出现了非 ASCII 字符')
  assert.ok(WIN_HELPER_PATH.endsWith('win-helper.ps1'))
})

test('win-helper.ps1 关键动作都在', () => {
  const source = winHelperSource()
  for (const marker of [
    'CloseMainWindow', // 先礼后兵：等同点关闭
    'Get-Process', // 按可执行文件路径找进程
    'explorer.exe', // 借 Explorer 的手启动，避开 job object
    'Start-Process',
    'bootPath', // 报到文件：宿主据此确认交接成功
    'statePath', // 进度文件：界面据此显示阶段
    'forceKill',
    'ConvertFrom-Json',
  ]) {
    assert.ok(source.includes(marker), `缺少 ${marker}`)
  }
  // 强杀默认关闭：用户点了「取消」时助手必须收手，不能硬杀出双实例。
  assert.ok(source.includes('if (-not $forceKill)'))
})

test('快捷方式脚本是纯 ASCII 且用参数传路径', () => {
  const script = shortcutScript()
  assert.ok(isAscii(script), '快捷方式脚本里出现了非 ASCII 字符')
  assert.ok(script.includes('CreateShortcut'))
  assert.ok(script.includes('$shortcut.TargetPath = $TargetPath'))
  // 路径通过 -File + 具名参数传，不拼命令行字符串
  assert.ok(script.includes('param('))
  assert.ok(script.includes('[string]$LnkPath'))
  assert.ok(/^\$shortcut\.Save\(\)/m.test(script))
})

test('psQuote 会把单引号写成两个', () => {
  assert.equal(psQuote('C:\\a\\b'), "'C:\\a\\b'")
  assert.equal(psQuote("D:\\O'Brien\\app.exe"), "'D:\\O''Brien\\app.exe'")
  assert.equal(psQuote(''), "''")
})

test('helperArguments 带上无交互与绕过执行策略', () => {
  const args = helperArguments('C:\\t\\win-helper.ps1', 'C:\\t\\p.json')
  assert.ok(args.startsWith('-NoProfile'))
  assert.ok(args.includes('-NonInteractive'))
  assert.ok(args.includes('-ExecutionPolicy Bypass'))
  assert.ok(args.includes('-PayloadFile'))
  assert.ok(args.includes('"C:\\t\\win-helper.ps1"'))
  assert.ok(args.includes('"C:\\t\\p.json"'))
})

test('buildPayload 把计划映射成助手要的字段', () => {
  const payload = buildPayload(
    {
      appPath: 'C:\\Apps\\DSH\\DeepSeek Harness.exe',
      imageName: 'DeepSeek Harness',
      logPath: 'C:\\t\\a.log',
      statePath: 'C:\\t\\state.json',
      quitTimeoutMs: 20000,
      openDelayMs: 800,
      forceKill: true,
    },
    { payloadPath: 'C:\\t\\p.json', bootPath: 'C:\\t\\boot.json' },
  )
  assert.equal(payload.exe, 'C:\\Apps\\DSH\\DeepSeek Harness.exe')
  assert.equal(payload.imageName, 'DeepSeek Harness')
  assert.equal(payload.logPath, 'C:\\t\\a.log')
  assert.equal(payload.statePath, 'C:\\t\\state.json')
  assert.equal(payload.quitTimeoutMs, 20000)
  assert.equal(payload.openDelayMs, 800)
  assert.equal(payload.forceKill, true)
  assert.equal(payload.bootPath, 'C:\\t\\boot.json')
  // 载荷要能被 ConvertFrom-Json 读回，所以必须是合法 JSON
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload)
})

test('waitBoot 读得到 pid，超时返回 null', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rr-boot-'))
  try {
    const boot = join(dir, 'boot.json')
    assert.equal(waitBoot(boot, { timeoutMs: 60, stepMs: 20 }), null)
    writeFileSync(boot, '{"pid":4321}', 'utf8')
    assert.equal(waitBoot(boot, { timeoutMs: 200, stepMs: 20 }).pid, 4321)
    writeFileSync(boot, 'not json', 'utf8')
    assert.equal(waitBoot(boot, { timeoutMs: 80, stepMs: 20 }), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('powershellPath 用 SystemRoot 拼绝对路径，找不到才退回命令名', () => {
  const found = powershellPath({ SystemRoot: 'D:\\Win' }, () => true)
  // 拼接用的是 path.join，在 Windows 上才是反斜杠；断言跟着用 join 拼。
  assert.equal(found, join('D:\\Win', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  assert.equal(powershellPath({ SystemRoot: 'D:\\Win' }, () => false), 'powershell.exe')
  assert.equal(powershellPath({}, () => true), join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
})

test('助手拒绝空 exe，避免误伤读不到路径的进程', () => {
  const source = winHelperSource()
  assert.ok(source.includes("throw 'payload has no exe path'"))
  assert.ok(source.includes("if ($path -ne '' -and $path -ieq $exe)"))
})
