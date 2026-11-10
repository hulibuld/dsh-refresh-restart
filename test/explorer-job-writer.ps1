param([Parameter(Mandatory = $true)][string]$PayloadFile)
$ErrorActionPreference = 'Stop'
$deadline = [DateTime]::UtcNow.AddSeconds(10)
$payload = [IO.File]::ReadAllText($PayloadFile) | ConvertFrom-Json
try {
    [IO.File]::WriteAllText([string]$payload.bootPath, (@{ pid = $PID; token = $payload.token } | ConvertTo-Json -Compress))
    while (-not (Test-Path -LiteralPath $payload.finishPath) -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 30
    }
} finally {
    [IO.File]::WriteAllText([string]$payload.donePath, (@{ pid = $PID; token = $payload.token } | ConvertTo-Json -Compress))
}
