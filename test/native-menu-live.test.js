import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { powershellPath } from '../lib/win.js'

// 需要显式启用，因为会短暂显示无害测试窗口。仅为旧版 WinForms 原生
// ContextMenu 测试夹具有意使用旧版 5.1。
// 生产助手仍使用 PowerShell 7；不操作任何 DSH 界面。
test('legacy Win32 popup is rejected by the Chromium Views-only production finder', {
  skip: process.platform !== 'win32' || process.env.DSH_TEST_NATIVE_MENU !== '1',
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-menu-test-'))
  const legacy = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const receipt = join(dir, 'receipt.txt')
  const child = spawn(legacy, ['-NoProfile', '-STA', '-File', fileURLToPath(new URL('./native-menu-fixture.ps1', import.meta.url)), '-Receipt', receipt],
    { stdio: 'ignore' })
  const exited = new Promise(resolve => child.once('exit', resolve))
  try {
    assert.ok(child.pid > 0)
    const script = join(dir, 'probe.ps1')
    const production = fileURLToPath(new URL('../lib/win-helper.ps1', import.meta.url)).replaceAll("'", "''")
    const quotedLegacy = legacy.replaceAll("'", "''")
    writeFileSync(script, `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${production}',[ref]$tokens,[ref]$errors)
if ($errors.Count -ne 0) { throw 'production script parse error' }
foreach ($name in @('Get-ProcessWindows','Find-NativeExitItem')) {
    $function=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
    if ($null -eq $function) { throw ('missing '+$name) }
    Invoke-Expression $function.Extent.Text
}
$fixture=Get-Process -Id ${child.pid} -ErrorAction Stop
if ($fixture.Path -ine '${quotedLegacy}') { throw 'fixture process identity mismatch' }
$deadline=(Get-Date).AddSeconds(8)
while ((Get-Date) -lt $deadline -and -not $fixture.HasExited) {
    $item=Find-NativeExitItem ${child.pid}
    if ($null -ne $item) { throw 'legacy popup was incorrectly accepted as Chromium Views' }
    Start-Sleep -Milliseconds 100
}
Write-Output 'legacy popup rejected without invoking any action'
`)
    const result = spawnSync(powershellPath(), ['-NoProfile', '-MTA', '-File', script], { encoding: 'utf8', timeout: 15000 })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr + result.stdout)
    await exited
    assert.match(readFileSync(receipt + '.events', 'utf8'), /popup;/, 'fixture must have shown a real legacy popup')
    assert.equal(existsSync(receipt), false, 'no legacy Exit action may run')
    assert.match(result.stdout, /legacy popup rejected/)
  } finally {
    // 即使探测失败，测试夹具也会在 10 秒后自行关闭。绝不按名称或路径
    // 终止进程，也绝不触碰真实的 DSH 进程。
    await exited
    rmSync(dir, { recursive: true, force: true })
  }
})
