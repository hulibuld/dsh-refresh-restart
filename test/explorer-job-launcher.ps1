param(
    [Parameter(Mandatory = $true)][string]$TargetPath,
    [Parameter(Mandatory = $true)][string]$Arguments,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$HandOffScript
)
$ErrorActionPreference = 'Stop'
# Test-only self-exit watchdog: unlike child_process timeout it sends no kill
# signal and never opens/terminates another process. Broker source is unchanged.
Add-Type -TypeDefinition @'
using System;
using System.Threading;
public static class ExplorerLauncherDeadline {
    private static Timer timer;
    public static void Arm() {
        timer = new Timer(_ => Environment.Exit(124), null, 6000, Timeout.Infinite);
    }
}
'@
[ExplorerLauncherDeadline]::Arm()
& $HandOffScript -TargetPath $TargetPath -Arguments:$Arguments -WorkingDirectory $WorkingDirectory
