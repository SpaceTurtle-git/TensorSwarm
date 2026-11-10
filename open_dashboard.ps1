<#
.SYNOPSIS
    Opens the TensorSwarm dashboard (notebook, jobs, cluster view) in the default browser.

.DESCRIPTION
    The Master serves the dashboard on its API port (8000), so any PC on the tailnet can use it
    with just a browser. This script picks the address:
      1. -MasterIP argument
      2. this PC runs the Master          -> http://localhost:8000
      3. the Master IP this worker used last (worker\.env)
      4. asks for it
.EXAMPLE
    open_dashboard.cmd
.EXAMPLE
    open_dashboard.cmd 100.101.102.103
#>
#Requires -Version 5.1
param(
    [Parameter(Position = 0)][string]$MasterIP,
    [int]$ApiPort = 8000
)

$ErrorActionPreference = 'Stop'
$UsbRoot = $PSScriptRoot
Import-Module (Join-Path $UsbRoot 'scripts\TensorSwarm.Common.psm1') -Force -DisableNameChecking

if (-not $MasterIP -and (Test-TsTcpPort -HostName '127.0.0.1' -Port $ApiPort)) {
    $MasterIP = 'localhost'
}
if (-not $MasterIP) {
    $envFile = Join-Path $UsbRoot 'worker\.env'
    if (Test-Path -LiteralPath $envFile) {
        foreach ($line in Get-Content -LiteralPath $envFile) {
            if ($line -match '^\s*MASTER_TAILSCALE_IP\s*=\s*(\S+)\s*$') { $MasterIP = $Matches[1] }
        }
    }
}
if (-not $MasterIP) {
    $MasterIP = (Read-Host "Enter the Master's Tailscale IP (e.g. 100.80.10.1)").Trim()
    if (-not $MasterIP) { Write-TsLog ERROR 'No Master IP given.'; exit 1 }
}

$url = "http://${MasterIP}:$ApiPort/"
$hostName = $MasterIP
if ($hostName -eq 'localhost') { $hostName = '127.0.0.1' }
if (Test-TsTcpPort -HostName $hostName -Port $ApiPort -TimeoutMs 2000) {
    Write-TsLog OK "Opening the dashboard: $url"
}
else {
    Write-TsLog WARN "The Master at ${MasterIP}:$ApiPort is not answering yet. Opening anyway: $url"
    Write-TsLog WARN 'Check that the Master is started and Tailscale is connected on both PCs.'
}
Start-Process $url
exit 0
