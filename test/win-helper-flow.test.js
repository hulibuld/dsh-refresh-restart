import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { powershellPath } from '../lib/win.js'

const source = readFileSync(new URL('../lib/win-helper.ps1', import.meta.url), 'utf8')
const marker = '\ntry {\n    Add-Type -AssemblyName UIAutomationClient'
const boundary = source.indexOf(marker)
assert.ok(boundary > 0, 'locate production helper main block before injecting test doubles')

// Execute production control flow, replacing ALL target/process/UIA operations
// with deterministic doubles. No actual application/menu/process is touched.
function simulate(scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-helper-flow-'))
  try {
    const payload = join(dir, 'payload.json')
    const state = join(dir, 'state.json')
    const effects = join(dir, 'effects.json')
    writeFileSync(payload, JSON.stringify({ exe: 'Z:\\not-a-real-app.exe', hostPid: 123, requestId: 'test-operation',
      statePath: state, logPath: join(dir, 'log.txt'), bootPath: join(dir, 'boot.json'),
      quitTimeoutMs: 1000, openDelayMs: 0 }))
    const doubles = `
$script:invocations = 0
$script:launches = 0
$script:checks = 0
$script:oldGone = $false
$script:scenario = '${scenario}'
function Resolve-AppMainProcess { return [pscustomobject]@{ Id=123; HasExited=$false } }
function Find-NativeExitItem {
    if ($script:scenario -eq 'missing-menu') { throw 'native Exit menu item unavailable' }
    $item = New-Object psobject
    $item | Add-Member ScriptMethod Invoke {
        $script:invocations++
        if ($script:scenario -eq 'accept' -or $script:scenario -eq 'already-reopened' -or $script:scenario -eq 'launch-error') { $script:oldGone=$true }
    }
    return $item
}
function Get-AppProcesses {
    $script:checks++
    if ($script:scenario -eq 'already-reopened' -and $script:checks -ge 2) {
        return @([pscustomobject]@{ Id=789; StartTime=(Get-Date).AddSeconds(1) })
    }
    if ($script:launches -gt 0) { return @([pscustomobject]@{ Id=456; StartTime=(Get-Date).AddSeconds(1) }) }
    if ($script:oldGone) { return @() }
    return @([pscustomobject]@{ Id=123; StartTime=(Get-Date).AddMinutes(-1) })
}
function Test-NativeDialog {
    if ($script:scenario -eq 'delayed-confirmation') {
        # Spend longer than quitTimeoutMs in a modal, then cancel. The watcher
        # must remain alive while it is present, not abandon a pending approval.
        return $script:checks -le 5
    }
    return $false
}
function Start-Process {
    if (Test-Path Env:ELECTRON_RUN_AS_NODE) { throw 'Electron node-mode flag leaked into relaunch' }
    if (Test-Path Env:ELECTRON_NO_ASAR) { throw 'Electron no-asar flag leaked into relaunch' }
    $script:launches++
    if ($script:scenario -eq 'launch-error') { throw 'synthetic launch failure' }
}
function Start-Sleep {
    # Preserve short real waits for timeout cases only.
    if ($script:scenario -eq 'cancel' -or $script:scenario -eq 'delayed-confirmation') {
        [System.Threading.Thread]::Sleep(300)
    }
}
function Write-TestEffects {
    [IO.File]::WriteAllText('${effects.replaceAll("'", "''")}', (@{invocations=$script:invocations;launches=$script:launches;checks=$script:checks} | ConvertTo-Json -Compress))
}
`
    // finally executes even when the production block calls exit.
    const flow = source.slice(boundary).replace('} finally {', '} finally {\n    Write-TestEffects')
    const script = join(dir, 'simulation.ps1')
    writeFileSync(script, source.slice(0, boundary) + doubles + flow)
    const result = spawnSync(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-PayloadFile', payload],
      { encoding: 'utf8', timeout: 15000, windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' } })
    assert.ifError(result.error)
    assert.ok([0, 1].includes(result.status), result.stderr)
    return { status: result.status, state: JSON.parse(readFileSync(state, 'utf8')), effects: JSON.parse(readFileSync(effects, 'utf8')) }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
const windows = { skip: process.platform !== 'win32' }
test('native exit accepted: wait for old processes then launch exactly once', windows, () => {
  const result = simulate('accept')
  assert.equal(result.status, 0)
  assert.equal(result.state.requestId, 'test-operation')
  assert.equal(result.state.phase, 'relaunched')
  assert.equal(result.effects.invocations, 1)
  assert.equal(result.effects.launches, 1)
})
test('missing exact native Exit: fail before requesting quit, never launch', windows, () => {
  const result = simulate('missing-menu')
  assert.equal(result.state.phase, 'quit-failed')
  assert.equal(result.effects.invocations, 0)
  assert.equal(result.effects.launches, 0)
})
test('cancelled native confirmation: leave running application untouched', windows, () => {
  const result = simulate('cancel')
  assert.equal(result.state.phase, 'cancelled')
  assert.equal(result.effects.invocations, 1)
  assert.equal(result.effects.launches, 0)
})
test('do not abandon a still-open native modal after quitTimeoutMs', windows, () => {
  const result = simulate('delayed-confirmation')
  assert.equal(result.state.phase, 'cancelled')
  assert.ok(result.effects.checks > 5)
  assert.equal(result.effects.launches, 0)
})
test('manual reopen between exit and launch does not create duplicate app', windows, () => {
  const result = simulate('already-reopened')
  assert.equal(result.state.phase, 'relaunched')
  assert.equal(result.effects.launches, 0)
})
test('launch error is terminal with no automatic retry', windows, () => {
  const result = simulate('launch-error')
  assert.equal(result.state.phase, 'launch-failed')
  assert.equal(result.effects.launches, 1)
})
