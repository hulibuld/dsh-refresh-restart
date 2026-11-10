import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  WIN_HELPER_PATH,
  buildPayload,
  helperArguments,
  handOff,
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
    'Find-NativeExitItem', // exact verified native menu item, not window close
    'Get-Process', // executable-path identity check
    'InvokePattern',
    'Start-Process',
    'bootPath', // 报到文件：宿主据此确认交接成功
    'statePath', // 进度文件：界面据此显示阶段
    'requestId',
    'hostPid',
    'ConvertFrom-Json',
  ]) {
    assert.ok(source.includes(marker), `缺少 ${marker}`)
  }
  // 强杀默认关闭：用户点了「取消」时助手必须收手，不能硬杀出双实例。
  assert.doesNotMatch(source, /CloseMainWindow|Stop-Process|taskkill/i)
  assert.ok(source.includes('no close or force-kill fallback'))
})

test('compatibility export uses the existing Explorer desktop, never a shortcut or new Shell.Application', () => {
  const script = shortcutScript()
  assert.ok(isAscii(script))
  assert.ok(script.includes('9BA05972-F6A8-11CF-A442-00A0C90A8F39'))
  assert.ok(script.includes('FindWindowSW([ref]$location, [ref]$root, 8, [ref]$hwnd, 1)'))
  assert.ok(script.includes('$application = $document.Application'))
  assert.ok(script.includes('$application.ShellExecute($TargetPath, $Arguments, $WorkingDirectory'))
  assert.ok(script.includes("throw 'Existing Explorer desktop unavailable'"))
  assert.ok(script.includes('ReleaseComObject'))
  assert.doesNotMatch(script, /CreateShortcut|WScript|\.lnk|New-Object|GetTypeFromProgID/)
})

test('psQuote 会把单引号写成两个', () => {
  assert.equal(psQuote('C:\\a\\b'), "'C:\\a\\b'")
  assert.equal(psQuote("D:\\O'Brien\\app.exe"), "'D:\\O''Brien\\app.exe'")
  assert.equal(psQuote(''), "''")
})

test('helperArguments quotes paths without encoded commands or execution-policy overrides', () => {
  const args = helperArguments("C:\\中文 path\\O'Brien\\helper.ps1", 'C:\\payload path\\p.json')
  assert.equal(args, '-NoProfile -NonInteractive -File "C:\\中文 path\\O\'Brien\\helper.ps1" -PayloadFile "C:\\payload path\\p.json"')
  assert.doesNotMatch(args, /-Command|-EncodedCommand|-ExecutionPolicy|Bypass/i)
  assert.throws(() => helperArguments('bad\npath', 'p'), /Invalid hand-off path/)
  assert.throws(() => helperArguments('h', 'bad\0path'), /Invalid hand-off path/)
  assert.ok(helperArguments('C:\\trailing\\', 'p').includes('"C:\\trailing\\\\"'))
  assert.ok(helperArguments('a"b', 'p').includes('"a\\"b"'))
})

test('buildPayload 把计划映射成助手要的字段', () => {
  const payload = buildPayload(
    {
      appPath: 'C:\\Apps\\DSH\\DeepSeek Harness.exe',
      requestId: 'request-123',
      hostPid: 5678,
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
  assert.equal(payload.requestId, 'request-123')
  assert.equal(payload.hostPid, 5678)
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
    for (const receipt of ['{}', '{"pid":0}', '{"pid":"4321"}', '[]', 'null']) {
      writeFileSync(boot, receipt, 'utf8')
      assert.equal(waitBoot(boot, { timeoutMs: 5, stepMs: 1 }), null)
    }
    writeFileSync(boot, 'not json', 'utf8')
    assert.equal(waitBoot(boot, { timeoutMs: 80, stepMs: 20 }), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('powershellPath prefers installed pwsh7; 5.1 requires explicit compatibility opt-in', () => {
  const env = { ProgramFiles: 'D:\\Programs', SystemRoot: 'D:\\Win', PATH: 'D:\\custom' }
  const preferred = join(env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe')
  const fromPath = join(env.PATH, 'pwsh.exe')
  const legacy = join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  assert.equal(powershellPath(env, () => true), preferred)
  assert.equal(powershellPath(env, (path) => path === fromPath), fromPath)
  assert.throws(() => powershellPath(env, (path) => path === legacy), /PowerShell 7.*not found/)
  assert.equal(powershellPath(env, (path) => path === legacy, { allowWindowsPowerShell: true }), legacy)
  assert.throws(() => powershellPath(env, () => false, { allowWindowsPowerShell: true }), /not found/)
})

test('handOff parameterizes ShellExecute and reports launcher failures without direct fallback', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-handoff-unit-'))
  const calls = []
  const options = { helperPath: join(dir, "中文 O'Brien helper.ps1"), payloadPath: join(dir, 'payload.json'),
    scriptPath: join(dir, 'handoff.ps1'), workDir: dir, env: { ProgramFiles: 'C:\\Programs' }, exists: () => true }
  try {
    const run = (...args) => { calls.push(args); return { status: 0 } }
    assert.deepEqual(handOff({ ...options, run }), { ok: true, mode: 'explorer-shell' })
    assert.equal(calls.length, 1)
    assert.ok(calls[0][0].endsWith('pwsh.exe'))
    assert.deepEqual(calls[0][1], ['-NoProfile', '-NonInteractive', '-STA', '-File', options.scriptPath,
      '-TargetPath', calls[0][0], `-Arguments:${helperArguments(options.helperPath, options.payloadPath)}`, '-WorkingDirectory', dir])
    for (const result of [{ status: 1, stderr: 'script execution is disabled' }, { status: null, error: new Error('timeout') }]) {
      const failed = handOff({ ...options, run: () => result })
      assert.equal(failed.ok, false)
      assert.equal(failed.mode, 'handoff-failed')
      assert.match(failed.warning, /execution policy is unchanged/)
    }
    assert.equal(handOff({ ...options, exists: () => false, run: () => assert.fail('must not launch') }).ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dispatch source has no shortcut/direct-spawn path and requires boot before success', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../lib/win.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\bspawn\s*\(|CreateShortcut|WScript|\.lnk|EncodedCommand|ExecutionPolicy.*Bypass/)
  const dispatch = source.slice(source.indexOf('export function dispatchWin'))
  assert.ok(dispatch.indexOf('if (boot === null)') < dispatch.indexOf('return { ok: true'))
  assert.match(dispatch, /Boot receipt already exists/)
  assert.match(dispatch, /未使用直接启动回退/)
  assert.match(dispatch, /readStartupFailure\(plan\)/)
})

// Explicit opt-in only: launches a harmless writer, NEVER win-helper or dispatchWin.
// It queries current Job membership, not survival across DSH shutdown.
test('live existing-Explorer ShellExecute starts a harmless parameterized script and queries Job membership', {
  skip: process.platform !== 'win32' || process.env.DSH_TEST_EXPLORER_HANDOFF !== '1',
}, async (t) => {
  const { mkdtempSync, writeFileSync, rmSync, readdirSync } = await import('node:fs')
  const { spawnSync } = await import('node:child_process')
  const { tmpdir } = await import('node:os')
  // Read-only native query shared by the DSH-started test-side pwsh and writer.
  // A null Job handle asks whether the current process belongs to ANY Job.
  const jobQuery = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class HarmlessJobProbe {',
    '  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();',
    '  [DllImport("kernel32.dll", SetLastError = true)]',
    '  [return: MarshalAs(UnmanagedType.Bool)]',
    '  public static extern bool IsProcessInJob(IntPtr process, IntPtr job, [MarshalAs(UnmanagedType.Bool)] out bool result);',
    '}',
    "'@",
    '$inJob = $false',
    'if (-not [HarmlessJobProbe]::IsProcessInJob([HarmlessJobProbe]::GetCurrentProcess(), [IntPtr]::Zero, [ref]$inJob)) {',
    '  throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())',
    '}',
  ].join('\r\n')
  const query = spawnSync(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command',
    `${jobQuery}\r\n[ordered]@{ pid = $PID; inJob = $inJob } | ConvertTo-Json -Compress`],
  { encoding: 'utf8', timeout: 12000, windowsHide: true })
  assert.ifError(query.error)
  assert.equal(query.status, 0, query.stderr)
  const parent = JSON.parse(query.stdout.trim())
  assert.ok(Number.isInteger(parent.pid) && parent.pid > 0)
  assert.equal(typeof parent.inJob, 'boolean')
  t.diagnostic(`DSH-started test-side pwsh: ${JSON.stringify(parent)}`)
  const dir = mkdtempSync(join(tmpdir(), "dsh harmless 中文 O'Brien "))
  try {
    const helperPath = join(dir, 'harmless helper.ps1')
    const payloadPath = join(dir, 'harmless payload.json')
    const bootPath = join(dir, 'harmless boot.json')
    writeFileSync(helperPath, [
      'param([Parameter(Mandatory = $true)][string]$PayloadFile)',
      jobQuery,
      '$payload = [IO.File]::ReadAllText($PayloadFile) | ConvertFrom-Json',
      '$receipt = [ordered]@{ pid = $PID; inJob = $inJob } | ConvertTo-Json -Compress',
      '[IO.File]::WriteAllText([string]$payload.bootPath, $receipt)',
    ].join('\r\n'), 'utf8')
    writeFileSync(payloadPath, JSON.stringify({ bootPath }), 'utf8')
    const hand = handOff({ helperPath, payloadPath, scriptPath: join(dir, 'handoff.ps1'), workDir: dir })
    assert.equal(hand.ok, true, hand.warning)
    const receipt = waitBoot(bootPath, { timeoutMs: 12000 })
    assert.ok(receipt, 'No harmless startup receipt; execution policy/security software may block unsigned scripts')
    assert.ok(Number.isInteger(receipt.pid) && receipt.pid > 0)
    assert.equal(typeof receipt.inJob, 'boolean')
    t.diagnostic(`Existing-Explorer harmless writer: ${JSON.stringify(receipt)}`)
    t.diagnostic('IsProcessInJob(null) reports membership in ANY Job, not a specific DSH Job; DSH exit survival NOT tested')
    assert.ok(!readdirSync(dir).some((name) => name.toLowerCase().endsWith('.lnk')))
    t.diagnostic(`ANY Job observations only: test-side pwsh=${parent.inJob}, Explorer writer=${receipt.inJob}; these may be different Jobs (including Store packaging Jobs). No specific-Job separation or DSH exit survival is established, and outside ALL Jobs is not a hand-off requirement.`)
  } finally {
    // The writer may still be exiting with this directory as its working directory.
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('助手拒绝空 exe，避免误伤读不到路径的进程', () => {
  const source = winHelperSource()
  assert.ok(source.includes("throw 'payload must contain exe and requestId'"))
  assert.ok(source.includes("$_.Path -ne '' -and $_.Path -ieq $exe"))
})
