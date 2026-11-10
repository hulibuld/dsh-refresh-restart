import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { powershellPath } from '../lib/win.js'

// 使用树结构替身执行真实生产匹配器，不执行任何操作。
// 真实 DSH 菜单发现已单独验证，未调用 Exit。
test('Views matcher accepts only unique native, enabled, visible, process-owned Exit', {
  skip: process.platform !== 'win32',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-views-matcher-'))
  try {
    const path = join(dir, 'matcher.ps1')
    const production = fileURLToPath(new URL('../lib/win-helper.ps1', import.meta.url)).replaceAll("'", "''")
    writeFileSync(path, `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${production}',[ref]$tokens,[ref]$errors)
if ($errors.Count -gt 0) { throw 'parse failure' }
$definition=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Find-NativeExitItem'},$true)
Invoke-Expression $definition.Extent.Text
function Get-ProcessWindows { return $script:windows }
function New-Node([string]$Class,[string]$Name='') {
    $node=[pscustomobject]@{
        Current=[pscustomobject]@{ClassName=$Class;Name=$Name;ProcessId=123;IsEnabled=$true;IsOffscreen=$false}
        Nodes=@(); Pattern=[pscustomobject]@{marker='pattern'}; HasPattern=$true; ExpectedScope=$null
    }
    $node | Add-Member ScriptMethod FindAll {
        param($scope,$condition)
        if ($null -ne $this.ExpectedScope -and $scope -ne $this.ExpectedScope) { throw 'incorrect tree scope' }
        return $this.Nodes
    }
    $node | Add-Member ScriptMethod TryGetCurrentPattern {
        param($pattern,[ref]$output)
        if (-not $this.HasPattern) { return $false }
        $output.Value=$this.Pattern
        return $true
    }
    return $node
}
function Reset-Tree {
    $script:item=New-Node 'MenuItemView' 'Exit'
    $script:menu=New-Node 'SubmenuView'
    $script:menu.ExpectedScope=[System.Windows.Automation.TreeScope]::Children
    $script:menu.Nodes=@($script:item)
    $script:window=New-Node 'Chrome_WidgetWin_1'
    $script:window.ExpectedScope=[System.Windows.Automation.TreeScope]::Descendants
    $script:window.Nodes=@($script:menu)
    $script:windows=@($script:window)
}
function Expect-Rejected([string]$Case,[scriptblock]$Change) {
    Reset-Tree
    & $Change
    if ($null -ne (Find-NativeExitItem 123)) { throw ('accepted '+$Case) }
    Write-Output ('PASS '+$Case)
}
Reset-Tree
if (-not [object]::ReferenceEquals((Find-NativeExitItem 123),$script:item.Pattern)) { throw 'valid native pattern rejected' }
Write-Output 'PASS valid English'
Reset-Tree
$script:item.Current.Name=[string][char]0x9000+[char]0x51FA
if ($null -eq (Find-NativeExitItem 123)) { throw 'Chinese Exit rejected' }
Write-Output 'PASS valid Chinese'
Expect-Rejected 'legacy popup' { $script:window.Current.ClassName='#32768' }
Expect-Rejected 'foreign window' { $script:window.Current.ProcessId=124 }
Expect-Rejected 'renderer menu' { $script:menu.Current.ClassName='HTMLMenu' }
Expect-Rejected 'foreign menu' { $script:menu.Current.ProcessId=124 }
Expect-Rejected 'hidden menu' { $script:menu.Current.IsOffscreen=$true }
Expect-Rejected 'renderer item' { $script:item.Current.ClassName='' }
Expect-Rejected 'foreign item' { $script:item.Current.ProcessId=124 }
Expect-Rejected 'disabled item' { $script:item.Current.IsEnabled=$false }
Expect-Rejected 'hidden item' { $script:item.Current.IsOffscreen=$true }
Expect-Rejected 'unknown label' { $script:item.Current.Name='Exit other app' }
Expect-Rejected 'missing Invoke' { $script:item.HasPattern=$false }
Reset-Tree
$script:menu.Nodes=@($script:item,(New-Node 'MenuItemView' 'Exit'))
$ambiguous=$false
try { $null=Find-NativeExitItem 123 } catch { if ($_.Exception.Message -match 'ambiguous') { $ambiguous=$true } else { throw } }
if (-not $ambiguous) { throw 'duplicate Exit did not fail closed' }
Write-Output 'PASS ambiguous'
`)
    const result = spawnSync(powershellPath(), ['-NoProfile', '-MTA', '-File', path], { encoding: 'utf8', timeout: 15000 })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr + result.stdout)
    assert.equal((result.stdout.match(/PASS /g) || []).length, 14)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
