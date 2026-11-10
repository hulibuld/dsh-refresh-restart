# dsh-refresh-restart Windows watcher. PowerShell 7 by default; ASCII source.
# Launched through the existing Explorer desktop, never through a temporary LNK.
# The client opens DSH's Application menu after ready-for-menu. UI Automation
# invokes only the exact native Exit item belonging to the verified app process.
# DSH itself owns the task-cancellation confirmation and graceful shutdown.
param([Parameter(Mandatory = $true)][string]$PayloadFile)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$payload = Get-Content -LiteralPath $PayloadFile -Raw | ConvertFrom-Json
$exe = [string]$payload.exe
$logPath = [string]$payload.logPath
$statePath = [string]$payload.statePath
$bootPath = [string]$payload.bootPath
$requestId = [string]$payload.requestId
$quitTimeoutMs = [Math]::Max(1000, [int]$payload.quitTimeoutMs)
$openDelayMs = [Math]::Max(0, [int]$payload.openDelayMs)
$appExited = $false
if ([string]::IsNullOrWhiteSpace($exe) -or [string]::IsNullOrWhiteSpace($requestId)) {
    throw 'payload must contain exe and requestId'
}
function Write-Log([string]$Message) {
    try { [IO.File]::AppendAllText($logPath, ((Get-Date).ToString('HH:mm:ss') + ' ' + $Message + "`r`n"), $utf8) } catch {}
}
function Write-State([string]$Phase, [string]$Detail = '') {
    $doc = [ordered]@{ requestId = $requestId; phase = $Phase; detail = $Detail; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    # Atomic replacement prevents the polling client from reading partial JSON.
    $temp = $statePath + '.' + $PID + '.tmp'
    [IO.File]::WriteAllText($temp, ($doc | ConvertTo-Json -Compress), $utf8)
    Move-Item -LiteralPath $temp -Destination $statePath -Force
}
function Get-AppProcesses {
    return @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -ne '' -and $_.Path -ieq $exe } catch { $false }
    })
}
function Resolve-AppMainProcess([int]$HostProcessId) {
    $current = $HostProcessId
    $seen = @{}
    $main = $null
    $sessionId = $null
    $childStarted = [DateTime]::MaxValue
    while ($current -gt 0) {
        if ($seen.ContainsKey($current)) { throw 'DSH ancestry contains a PID cycle' }
        $seen[$current] = $true
        $process = Get-Process -Id $current -ErrorAction Stop
        if ($process.Path -ine $exe) { break }
        if ($null -eq $sessionId) { $sessionId = $process.SessionId }
        if ($process.SessionId -ne $sessionId -or $process.StartTime -gt $childStarted) {
            throw 'DSH ancestry session/start-time mismatch'
        }
        $record = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $current) -ErrorAction Stop
        if ($null -eq $record -or [Math]::Abs((([DateTime]$record.CreationDate) - $process.StartTime).TotalSeconds) -gt 1) {
            throw 'DSH ancestry process identity changed during discovery'
        }
        $main = $process
        # A verified app-owned window marks the main process, not its launcher.
        # After relaunch, its parent is our short-lived watcher and may be gone.
        # Never follow that stale parent PID (which may also have been reused).
        if ($main.MainWindowHandle -ne [IntPtr]::Zero) { break }
        $childStarted = $process.StartTime
        $current = [int]$record.ParentProcessId
    }
    if ($null -eq $main -or $main.MainWindowHandle -eq [IntPtr]::Zero) {
        throw 'cannot verify the DSH main process from host ancestry'
    }
    return $main
}
function Get-ProcessWindows([int]$ProcessId) {
    $condition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcessId)
    return [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
        [System.Windows.Automation.TreeScope]::Children, $condition)
}
function Find-NativeExitItem([int]$ProcessId) {
    $windows = Get-ProcessWindows $ProcessId
    $candidates = @()
    $menuCondition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Menu)
    $itemCondition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::MenuItem)
    foreach ($window in $windows) {
        # Electron uses Chromium Views, NOT a Win32 #32768 popup/HMENU.
        # These native classes and parent/child relationships were observed in
        # the actual DSH menu. Do not match renderer content by label alone.
        if ($window.Current.ProcessId -ne $ProcessId -or
            $window.Current.ClassName -notmatch '^Chrome_WidgetWin_[0-9]+$') { continue }
        foreach ($menu in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $menuCondition)) {
            if ($menu.Current.ClassName -cne 'SubmenuView' -or
                $menu.Current.ProcessId -ne $ProcessId -or $menu.Current.IsOffscreen) { continue }
            foreach ($item in $menu.FindAll([System.Windows.Automation.TreeScope]::Children, $itemCondition)) {
                $info = $item.Current
                $label = ($info.Name -split "`t")[0].Replace('&', '').Trim()
                if ($info.ClassName -ceq 'MenuItemView' -and $info.ProcessId -eq $ProcessId -and
                    $info.IsEnabled -and -not $info.IsOffscreen -and
                    ($label -ceq 'Exit' -or $label -ceq ([string][char]0x9000 + [char]0x51FA))) {
                    $pattern = $null
                    if ($item.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
                        $candidates += $pattern
                    }
                }
            }
        }
    }
    if ($candidates.Count -gt 1) { throw 'ambiguous native Exit menu item' }
    if ($candidates.Count -eq 1) { return $candidates[0] }
    return $null
}
function Test-NativeDialog([int]$ProcessId) {
    foreach ($window in (Get-ProcessWindows $ProcessId)) {
        if ($window.Current.ClassName -eq '#32770' -and -not $window.Current.IsOffscreen) { return $true }
    }
    return $false
}
try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $main = Resolve-AppMainProcess ([int]$payload.hostPid)
    $mainId = $main.Id
    Write-Log ('watcher pid=' + $PID + ' app main pid=' + $mainId)
    Write-State 'ready-for-menu'
    [IO.File]::WriteAllText($bootPath, ('{"pid":' + $PID + '}'), $utf8)

    # This stage has no exit side effect until an exact, app-owned item is found.
    $deadline = (Get-Date).AddSeconds(15)
    $exitItem = $null
    while ((Get-Date) -lt $deadline -and $null -eq $exitItem) {
        if ($main.HasExited) { throw 'DSH exited before the native Exit request' }
        $exitItem = Find-NativeExitItem $mainId
        if ($null -eq $exitItem) { Start-Sleep -Milliseconds 100 }
    }
    if ($null -eq $exitItem) { throw 'native Exit menu item unavailable; no close or force-kill fallback' }
    Write-State 'quitting'
    $exitItem.Invoke()
    Write-Log 'invoked DSH native Exit; DSH owns the confirmation dialog'

    $deadline = (Get-Date).AddMilliseconds($quitTimeoutMs)
    while ((Get-AppProcesses).Count -gt 0) {
        # Never time out while the user is still deciding in DSH's native dialog.
        if (Test-NativeDialog $mainId) {
            Write-State 'awaiting-confirmation'
            $deadline = (Get-Date).AddMilliseconds($quitTimeoutMs)
        } elseif ((Get-Date) -ge $deadline) {
            Write-Log 'app still running after native quit; leaving it untouched'
            Write-State 'cancelled' 'DSH did not exit; no process was killed or relaunched'
            exit 0
        }
        Start-Sleep -Milliseconds 300
    }
    $appExited = $true
    Write-Log 'all matching DSH executable processes exited'
    Start-Sleep -Milliseconds $openDelayMs
    # Guard against a manual relaunch between the wait and our launch.
    if ((Get-AppProcesses).Count -gt 0) {
        Write-State 'relaunched' 'application already reopened'
        exit 0
    }
    $since = Get-Date
    Write-State 'launching'
    # Launch from the Explorer-handed-off watcher, not the terminating Host.
    # Actual DSH shutdown survival still needs end-to-end verification.
    # Do not launch twice merely because startup is slow.
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Remove-Item Env:ELECTRON_NO_ASAR -ErrorAction SilentlyContinue
    Start-Process -FilePath $exe -WorkingDirectory ([IO.Path]::GetDirectoryName($exe)) | Out-Null
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline) {
        foreach ($process in (Get-AppProcesses)) {
            if ($process.StartTime -ge $since) {
                Write-State 'relaunched' ('new process pid=' + $process.Id + '; GUI readiness not verified')
                Write-Log ('new process observed pid=' + $process.Id)
                exit 0
            }
        }
        Start-Sleep -Milliseconds 300
    }
    throw 'no new DSH process observed; launch was not retried'
} catch {
    $message = $_.Exception.Message
    Write-Log ('helper error: ' + $message)
    if ($appExited) { Write-State 'launch-failed' $message }
    else { Write-State 'quit-failed' $message }
    exit 1
} finally {
    Remove-Item -LiteralPath $PayloadFile -Force -ErrorAction SilentlyContinue
}
