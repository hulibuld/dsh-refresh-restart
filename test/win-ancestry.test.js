import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { powershellPath, readStartupFailure } from '../lib/win.js'

test('production ancestry stops at the verified main window, even after its launcher exits or PID is reused', {
  skip: process.platform !== 'win32',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ancestry-'))
  try {
    const path = join(dir, 'probe.ps1')
    const production = fileURLToPath(new URL('../lib/win-helper.ps1', import.meta.url)).replaceAll("'", "''")
    writeFileSync(path, `
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${production}',[ref]$tokens,[ref]$errors)
if ($errors.Count -gt 0) { throw 'parse failure' }
$definition=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Resolve-AppMainProcess'},$true)
Invoke-Expression $definition.Extent.Text
$exe='C:\\Example\\DSH.exe'
function Reset-Tree {
  $script:calls=@()
  $script:processes=@{
    101=[pscustomobject]@{Id=101;Path=$exe;SessionId=1;StartTime=[datetime]'2026-11-10T12:01:00';MainWindowHandle=[IntPtr]::Zero}
    202=[pscustomobject]@{Id=202;Path=$exe;SessionId=1;StartTime=[datetime]'2026-11-10T12:00:00';MainWindowHandle=[IntPtr]123}
  }
  $script:records=@{
    101=[pscustomobject]@{ParentProcessId=202;CreationDate=$script:processes[101].StartTime}
    202=[pscustomobject]@{ParentProcessId=303;CreationDate=$script:processes[202].StartTime}
  }
}
function Get-Process { param([int]$Id) $script:calls += $Id; if (-not $script:processes.ContainsKey($Id)) { throw ('missing PID '+$Id) }; return $script:processes[$Id] }
function Get-CimInstance { param($ClassName,$Filter) return $script:records[[int]($Filter -replace '^ProcessId=','')] }
function Expect-Rejected([string]$Name,[scriptblock]$Change) {
  Reset-Tree
  & $Change
  $failed=$false
  try { $null=Resolve-AppMainProcess 101 } catch { $failed=$true }
  if (-not $failed) { throw ('accepted unsafe ancestry: '+$Name) }
  Write-Output ('PASS '+$Name)
}
Reset-Tree
if ((Resolve-AppMainProcess 101).Id -ne 202 -or $script:calls -contains 303) { throw 'followed exited launcher after relaunch' }
Write-Output 'PASS exited launcher'
Reset-Tree
$script:processes[303]=[pscustomobject]@{Id=303;Path=$exe;SessionId=9;StartTime=[datetime]'2026-11-10T13:00:00';MainWindowHandle=[IntPtr]456}
if ((Resolve-AppMainProcess 101).Id -ne 202 -or $script:calls -contains 303) { throw 'followed reused launcher PID' }
Write-Output 'PASS reused launcher PID'
Expect-Rejected 'missing host' { $script:processes.Remove(101) }
Expect-Rejected 'missing main' { $script:processes.Remove(202) }
Expect-Rejected 'foreign executable' { $script:processes[202].Path='C:\\Other.exe' }
Expect-Rejected 'foreign session' { $script:processes[202].SessionId=2 }
Expect-Rejected 'newer parent' { $script:processes[202].StartTime=[datetime]'2026-11-10T12:02:00' }
Expect-Rejected 'identity mismatch' { $script:records[202].CreationDate=[datetime]'2026-11-10T11:00:00' }
Expect-Rejected 'PID cycle' { $script:processes[202].MainWindowHandle=[IntPtr]::Zero; $script:records[202].ParentProcessId=101 }
Expect-Rejected 'no main window' { $script:processes[202].MainWindowHandle=[IntPtr]::Zero; $script:records[202].ParentProcessId=0 }
`)
    const result = spawnSync(powershellPath(), ['-NoProfile', '-File', path], { encoding: 'utf8', timeout: 15000 })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr + result.stdout)
    assert.equal((result.stdout.match(/PASS /g) || []).length, 10)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('startup errors are correlated to the current request, not guessed to be antivirus blocks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-startup-error-'))
  const plan = { statePath: join(dir, 'state.json'), requestId: 'current' }
  try {
    assert.equal(readStartupFailure(plan), null)
    writeFileSync(plan.statePath, '{')
    assert.equal(readStartupFailure(plan), null)
    writeFileSync(plan.statePath, JSON.stringify({ requestId: 'old', phase: 'quit-failed', detail: 'stale error' }))
    assert.equal(readStartupFailure(plan), null)
    writeFileSync(plan.statePath, JSON.stringify({ requestId: 'current', phase: 'ready-for-menu', detail: 'not an error' }))
    assert.equal(readStartupFailure(plan), null)
    writeFileSync(plan.statePath, JSON.stringify({ requestId: 'current', phase: 'quit-failed', detail: 'missing PID' }))
    assert.equal(readStartupFailure(plan), 'missing PID')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
