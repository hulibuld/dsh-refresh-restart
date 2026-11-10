import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { powershellPath } from '../lib/win.js'

// Explicit opt-in: expands the running DSH Application menu, but NEVER invokes
// Exit, starts the restart service, or accepts any confirmation.
test('actual DSH Views menu is recognized without invoking Exit', {
  skip: process.platform !== 'win32' || process.env.DSH_TEST_MENU_DISCOVERY !== '1',
}, () => {
  assert.ok(process.env.DSH_TEST_APP_EXE, 'Explicit exact DSH executable path required')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-menu-discovery-'))
  try {
    const path = join(dir, 'discover.ps1')
    const production = fileURLToPath(new URL('../lib/win-helper.ps1', import.meta.url)).replaceAll("'", "''")
    const exe = process.env.DSH_TEST_APP_EXE.replaceAll("'", "''")
    writeFileSync(path, `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${production}',[ref]$tokens,[ref]$errors)
if ($errors.Count -gt 0) { throw 'parse failure' }
foreach ($name in @('Get-ProcessWindows','Find-NativeExitItem')) {
    $definition=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
    Invoke-Expression $definition.Extent.Text
}
$apps=@(Get-Process | Where-Object { $_.Path -ieq '${exe}' -and $_.MainWindowHandle -ne 0 })
if ($apps.Count -ne 1) { throw 'Expected exactly one explicitly identified DSH main window' }
$app=$apps[0]
$root=[System.Windows.Automation.AutomationElement]::FromHandle($app.MainWindowHandle)
$condition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::MenuItem)
$buttons=@($root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition) | Where-Object {
    $_.Current.ClassName -eq '' -and $_.Current.Name -cin @('Application','App',([string][char]0x5E94+[char]0x7528))
})
if ($buttons.Count -ne 1) { throw 'Application button identity ambiguous' }
$buttons[0].GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
$pattern=Find-NativeExitItem $app.Id
if ($null -eq $pattern) { throw 'Production matcher did not find a unique native Exit' }
if ($pattern -isnot [System.Windows.Automation.InvokePattern]) { throw 'Unexpected pattern' }
Write-Output 'MATCHED; Exit was NOT invoked'
`)
    const result = spawnSync(powershellPath(), ['-NoProfile', '-MTA', '-File', path], { encoding: 'utf8', timeout: 15000 })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr + result.stdout)
    assert.match(result.stdout, /MATCHED; Exit was NOT invoked/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
