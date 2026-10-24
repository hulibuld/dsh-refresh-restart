# dsh-refresh-restart - Windows restart helper.
#
# Why a PowerShell helper instead of the Node one used on macOS/Linux:
# the desktop app is started by Chromium, and its whole process tree lives in a
# job object with kill-on-close. A child process spawned from inside that tree
# dies together with the app, so it can never bring the app back. This script is
# started by Explorer (outside the job), which is why it survives the shutdown it
# causes itself.
#
# ASCII only on purpose: Windows PowerShell 5.1 decodes BOM-less UTF-8 script
# files as ANSI, so non-ASCII text here would turn into syntax errors.
#
# Action: read payload JSON, ask the app to close, wait for it to really exit,
# then relaunch it through the shell and verify a new process appeared.

param(
    [Parameter(Mandatory = $true)][string]$PayloadFile
)

$ErrorActionPreference = 'Stop'

$payload = Get-Content -LiteralPath $PayloadFile -Raw | ConvertFrom-Json
$exe = [string]$payload.exe
$logPath = [string]$payload.logPath
$statePath = [string]$payload.statePath
$bootPath = [string]$payload.bootPath
$quitTimeoutMs = [int]$payload.quitTimeoutMs
if ($quitTimeoutMs -le 0) { $quitTimeoutMs = 20000 }
$openDelayMs = [int]$payload.openDelayMs
if ($openDelayMs -lt 0) { $openDelayMs = 800 }
$forceKill = [bool]$payload.forceKill

if ([string]::IsNullOrEmpty($exe)) {
    # Without a target executable every path match below would succeed on
    # processes whose Path is unreadable, and we would close the wrong things.
    throw 'payload has no exe path'
}

$utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-Log {
    param([string]$Message)
    try {
        $line = (Get-Date).ToString('HH:mm:ss') + ' ' + $Message
        [IO.File]::AppendAllText($logPath, $line + "`r`n", $utf8)
    }
    catch { }
}

function Write-State {
    param([string]$Phase, [string]$Detail)
    try {
        $doc = [ordered]@{
            phase  = $Phase
            detail = $Detail
            at     = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
        }
        [IO.File]::WriteAllText($statePath, ($doc | ConvertTo-Json -Compress), $utf8)
    }
    catch { }
}

# Every process whose executable is exactly our app. Path matching is what makes
# this reliable: the process name is whatever the vendor shipped, and localized
# tasklist output is a trap.
function Get-AppProcesses {
    param([int]$ExcludePid = 0)
    $found = New-Object System.Collections.ArrayList
    foreach ($proc in (Get-Process -ErrorAction SilentlyContinue)) {
        if ($null -eq $proc) { continue }
        if ($ExcludePid -gt 0 -and $proc.Id -eq $ExcludePid) { continue }
        $path = ''
        try { $path = [string]$proc.Path } catch { $path = '' }
        if ($path -ne '' -and $path -ieq $exe) { [void]$found.Add($proc) }
    }
    return , $found
}

try {
    # Check in first: the side that started us waits for this file, so it learns
    # the hand-off actually worked (and gets our pid for the status document).
    try {
        [IO.File]::WriteAllText($bootPath, ('{"pid":' + $PID + '}'), $utf8)
    }
    catch { }

    Write-Log ('helper start pid=' + $PID + ' exe=' + $exe)
    Write-State 'starting' ''

    Start-Sleep -Milliseconds 1000

    # 1) polite shutdown: same as clicking the window's close button
    $targets = Get-AppProcesses
    $ids = @($targets | ForEach-Object { $_.Id })
    Write-Log ('app processes: ' + ($ids -join ','))
    foreach ($proc in $targets) {
        try { $null = $proc.CloseMainWindow() }
        catch { Write-Log ('CloseMainWindow failed for ' + $proc.Id + ': ' + $_.Exception.Message) }
    }

    Write-State 'quitting' ''
    $deadline = (Get-Date).AddMilliseconds($quitTimeoutMs)
    while ((Get-Date) -lt $deadline) {
        if ((Get-AppProcesses).Count -eq 0) { break }
        Start-Sleep -Milliseconds 300
    }

    if ((Get-AppProcesses).Count -gt 0) {
        if (-not $forceKill) {
            # Most likely the user hit "cancel" in the app's own close prompt.
            # Killing anyway is how you end up with two instances fighting over
            # one port, so stop here.
            Write-Log 'app did not exit, restart cancelled (forceKill is off)'
            Write-State 'cancelled' 'app did not exit'
            exit 0
        }
        Write-Log 'app did not exit, killing it (forceKill is on)'
        Write-State 'force-kill' ''
        foreach ($proc in (Get-AppProcesses)) {
            try { $proc.Kill() } catch { Write-Log ('kill failed: ' + $_.Exception.Message) }
        }
        $killDeadline = (Get-Date).AddSeconds(10)
        while ((Get-Date) -lt $killDeadline) {
            if ((Get-AppProcesses).Count -eq 0) { break }
            Start-Sleep -Milliseconds 300
        }
        if ((Get-AppProcesses).Count -gt 0) {
            Write-Log 'still running after kill, giving up'
            Write-State 'cancelled' 'app did not exit'
            exit 0
        }
    }

    Write-Log 'app exited'
    Start-Sleep -Milliseconds $openDelayMs

    # 2) relaunch. Explorer is outside the job object, so a shortcut started by it
    # produces a process that outlives everything we just killed and lands on the
    # interactive desktop where the user can see it.
    $started = $null

    function Start-ViaShell {
        $shell = New-Object -ComObject WScript.Shell
        $lnk = [IO.Path]::Combine([IO.Path]::GetTempPath(), ('dsh-refresh-restart-app-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.lnk'))
        $shortcut = $shell.CreateShortcut($lnk)
        $shortcut.TargetPath = $exe
        $shortcut.WorkingDirectory = [IO.Path]::GetDirectoryName($exe)
        $shortcut.WindowStyle = 1
        $shortcut.Save()
        # The temp path can contain spaces; explorer gets it quoted or it opens
        # the wrong folder.
        Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $lnk + '"') | Out-Null
        return $lnk
    }

    function Start-Directly {
        Start-Process -FilePath $exe -WorkingDirectory ([IO.Path]::GetDirectoryName($exe)) | Out-Null
    }

    function Wait-NewApp {
        param([int]$TimeoutMs, [datetime]$Since)
        $limit = (Get-Date).AddMilliseconds($TimeoutMs)
        while ((Get-Date) -lt $limit) {
            foreach ($proc in (Get-AppProcesses)) {
                $start = $null
                try { $start = $proc.StartTime } catch { $start = $null }
                if ($null -ne $start -and $start -gt $Since) { return $proc }
            }
            Start-Sleep -Milliseconds 300
        }
        return $null
    }

    $since = Get-Date
    Write-Log 'relaunching through explorer'
    try { $null = Start-ViaShell } catch { Write-Log ('explorer route failed: ' + $_.Exception.Message) }
    $started = Wait-NewApp -TimeoutMs 25000 -Since $since

    if ($null -eq $started) {
        Write-Log 'no new process yet, retrying with a direct Start-Process'
        $since = Get-Date
        try { Start-Directly } catch { Write-Log ('Start-Process failed: ' + $_.Exception.Message) }
        $started = Wait-NewApp -TimeoutMs 15000 -Since $since
    }

    if ($null -ne $started) {
        Write-Log ('relaunched ok, new pid=' + $started.Id)
        Write-State 'relaunched' ''
    }
    else {
        Write-Log 'relaunch failed: no new process appeared'
        Write-State 'launch-failed' ''
    }

    try { Remove-Item -LiteralPath $PayloadFile -Force -ErrorAction SilentlyContinue } catch { }
    exit 0
}
catch {
    $message = $_.Exception.Message
    Write-Log ('helper error: ' + $message)
    Write-State 'launch-failed' $message
    exit 1
}
