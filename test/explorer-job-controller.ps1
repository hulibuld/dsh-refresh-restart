param(
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$WorkerPath,
    [Parameter(Mandatory = $true)][string]$WriterPath,
    [Parameter(Mandatory = $true)][string]$Directory,
    [Parameter(Mandatory = $true)][string]$Token
)
$ErrorActionPreference = 'Stop'
# Test-only native surface. No job limits, kill-on-close, termination or breakaway.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ExplorerTestJob {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsProcessInJob(IntPtr process, IntPtr job, [MarshalAs(UnmanagedType.Bool)] out bool result);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr handle);
}
'@
function Native-Failure([string]$Operation) {
    throw "$Operation failed; cannot prove specific-Job separation: $([ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()).Message)"
}
$deadline = [DateTime]::UtcNow.AddSeconds(15)
function Read-Receipt([string]$Name) {
    $path = Join-Path $Directory $Name
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Path -LiteralPath $path) {
            try { return ([IO.File]::ReadAllText($path) | ConvertFrom-Json) } catch { }
        }
        $errorPath = Join-Path $Directory 'worker-error.json'
        if (Test-Path -LiteralPath $errorPath) { throw "Worker failed: $([IO.File]::ReadAllText($errorPath))" }
        Start-Sleep -Milliseconds 30
    }
    throw "Timed out waiting for $Name; cannot prove specific-Job separation"
}
$job = [IntPtr]::Zero
$workerHandle = [IntPtr]::Zero
$writerHandle = [IntPtr]::Zero
$worker = $null
$writer = $null
$result = [ordered]@{ ok = $false; workerSpecificJob = $null; writerSpecificJob = $null; survivalTested = $false }
try {
    $job = [ExplorerTestJob]::CreateJobObject([IntPtr]::Zero, $null)
    if ($job -eq [IntPtr]::Zero) { Native-Failure 'CreateJobObject' }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $NodePath
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    foreach ($arg in @($WorkerPath, $Directory, $Token, $WriterPath)) { $start.ArgumentList.Add($arg) }
    $worker = [Diagnostics.Process]::Start($start)
    $workerStart = $worker.StartTime.ToUniversalTime().Ticks
    $ready = Read-Receipt 'ready.json'
    # Only the process THIS controller just created can reach Assign. Never accept
    # an externally supplied PID, the test runner PID, or a DSH PID.
    if ($worker.HasExited -or $ready.pid -ne $worker.Id -or $ready.token -cne $Token -or
        $ready.execPath -ine $NodePath -or $worker.Path -ine $NodePath -or
        $worker.StartTime.ToUniversalTime().Ticks -ne $workerStart) { throw 'New worker identity validation failed' }
    # PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION.
    # PROCESS_TERMINATE is required by AssignProcessToJobObject, NEVER exercised.
    $workerHandle = [ExplorerTestJob]::OpenProcess(0x1101, $false, [uint32]$worker.Id)
    if ($workerHandle -eq [IntPtr]::Zero) { Native-Failure 'OpenProcess(worker)' }
    if ($worker.HasExited -or $worker.StartTime.ToUniversalTime().Ticks -ne $workerStart) { throw 'Worker exited before assignment' }
    if (-not [ExplorerTestJob]::AssignProcessToJobObject($job, $workerHandle)) { Native-Failure 'AssignProcessToJobObject' }
    $inside = $false
    if (-not [ExplorerTestJob]::IsProcessInJob($workerHandle, $job, [ref]$inside)) { Native-Failure 'IsProcessInJob(worker)' }
    $result.workerPid = $worker.Id
    $result.workerSpecificJob = $inside
    if (-not $inside) { throw 'Worker not in dedicated test Job; cannot prove separation' }
    [IO.File]::WriteAllText((Join-Path $Directory 'gate'), $Token)
    $boot = Read-Receipt 'boot.json'
    $receipt = Read-Receipt 'receipt.json'
    if ($boot.token -cne $Token -or $receipt.token -cne $Token -or $receipt.pid -ne $boot.pid -or
        $boot.pid -le 0 -or $boot.pid -eq $worker.Id -or $boot.pid -eq $PID) { throw 'Writer receipt identity validation failed' }
    $writer = [Diagnostics.Process]::GetProcessById([int]$boot.pid)
    if ($writer.HasExited -or $writer.Path -ine (Get-Process -Id $PID).Path) { throw 'Writer process identity validation failed' }
    # Writer handle is READ-ONLY. No Assign call for the writer or any existing process.
    $writerHandle = [ExplorerTestJob]::OpenProcess(0x1000, $false, [uint32]$boot.pid)
    if ($writerHandle -eq [IntPtr]::Zero) { Native-Failure 'OpenProcess(writer)' }
    $writerInside = $false
    if (-not [ExplorerTestJob]::IsProcessInJob($writerHandle, $job, [ref]$writerInside)) { Native-Failure 'IsProcessInJob(writer)' }
    $writerAny = $false
    if (-not [ExplorerTestJob]::IsProcessInJob($writerHandle, [IntPtr]::Zero, [ref]$writerAny)) { Native-Failure 'IsProcessInJob(writer ANY)' }
    $result.writerPid = $boot.pid
    $result.writerSpecificJob = $writerInside
    $result.writerAnyJob = $writerAny
    if ($writerInside) { throw 'Explorer writer remains in dedicated test Job' }
    $result.ok = $true
} catch {
    $result.error = $_.Exception.Message
} finally {
    [IO.File]::WriteAllText((Join-Path $Directory 'finish'), $Token)
    # All fixtures have independent deadlines; only wait for natural exits.
    if ($null -ne $worker) { $result.workerExited = $worker.WaitForExit(2000) }
    if ($null -ne $writer) { $result.writerExited = $writer.WaitForExit(2000) }
    foreach ($handle in @($writerHandle, $workerHandle, $job)) {
        if ($handle -ne [IntPtr]::Zero) { [void][ExplorerTestJob]::CloseHandle($handle) }
    }
    if ($null -ne $worker) { $worker.Dispose() }
    if ($null -ne $writer) { $writer.Dispose() }
}
$result | ConvertTo-Json -Compress
if (-not $result.ok) { exit 1 }
