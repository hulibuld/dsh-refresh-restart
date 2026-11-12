param(
    [Parameter(Mandatory = $true)][string]$TargetPath,
    [Parameter(Mandatory = $true)][string]$Arguments,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$HandOffScript
)
$ErrorActionPreference = 'Stop'
# 仅供测试使用的自行退出看门狗：与 child_process 超时不同，它不发送终止
# 信号，也不会打开或终止其他进程。代理源码保持不变。
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
