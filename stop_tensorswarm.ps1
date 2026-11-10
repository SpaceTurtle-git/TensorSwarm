<#
.SYNOPSIS
    Stops every TensorSwarm process that was launched from THIS USB's portable python.exe:
    the telemetry agent, the uvicorn/FastAPI backend, the Ray launcher and all Ray processes
    (raylet.exe, gcs_server.exe, dashboard, task workers).

.DESCRIPTION
    Processes are selected by executable path: only executables located inside
    <USB>\TensorSwarm\python_env\ are matched. The user's own Python installs, IDEs, Jupyter,
    Anaconda etc. run from other paths and are never touched.

.EXAMPLE
    E:\TensorSwarm\stop_tensorswarm.cmd
.EXAMPLE
    .\stop_tensorswarm.ps1 -WhatIf      # list what would be stopped, stop nothing
#>
#Requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    # Minimal output (used by the start scripts to clear leftovers).
    [switch]$Quiet,
    [int]$TimeoutSec = 20
)

$ErrorActionPreference = 'Stop'
$UsbRoot   = $PSScriptRoot
$PythonEnv = Join-Path $UsbRoot 'python_env'
Import-Module (Join-Path $UsbRoot 'scripts\TensorSwarm.Common.psm1') -Force -DisableNameChecking

# Stop the things that talk to Ray first, then Ray from the top of its tree down,
# so raylet does not keep respawning task workers while we are cleaning up.
$order = @{
    'Telemetry agent' = 1; 'FastAPI backend' = 2; 'Ray launcher' = 3; 'Ray task worker' = 4
    'Ray dashboard'   = 5; 'Ray service'     = 5; 'Python (USB env)' = 5; 'Ray raylet' = 6; 'Ray GCS server' = 7
}

if (-not $Quiet) { Write-TsBanner 'TensorSwarm - Stop (Windows native)' }

$scan = Get-TsOwnedProcesses -PythonEnv $PythonEnv
$found = @($scan.Processes)

if ($found.Count -eq 0) {
    if (-not $Quiet) {
        Write-TsLog OK "No TensorSwarm processes running from $PythonEnv."
        if ($scan.HiddenCount -gt 0 -and -not (Test-TsIsAdmin)) {
            Write-TsLog WARN "$($scan.HiddenCount) python/raylet/gcs_server process(es) could not be inspected (started as Administrator or by another user)."
            Write-TsLog WARN 'If TensorSwarm was started from an Administrator terminal, run this script from one too.'
        }
    }
    return
}

if ($Quiet) {
    Write-TsLog INFO "Stopping $($found.Count) leftover TensorSwarm process(es) from a previous run ..."
}
else {
    Write-TsLog INFO "Found $($found.Count) TensorSwarm process(es):"
    $found | Sort-Object { $order[$_.Role] }, Id |
        Format-Table -AutoSize @{ L = 'PID'; E = { $_.Id } }, @{ L = 'Role'; E = { $_.Role } }, @{ L = 'Executable'; E = { $_.Name } } |
        Out-String -Width 200 | Write-Host
}

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$stopped = 0
do {
    foreach ($p in ($found | Sort-Object { $order[$_.Role] }, Id)) {
        if ($PSCmdlet.ShouldProcess("PID $($p.Id) [$($p.Role)]", 'Stop-Process')) {
            try {
                Stop-Process -Id $p.Id -Force -ErrorAction Stop
                $stopped++
                if (-not $Quiet) { Write-TsLog OK ("Stopped {0,-16} PID {1}" -f $p.Role, $p.Id) }
            }
            catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
                # Already gone (e.g. a child that died with its parent).
            }
            catch {
                Write-TsLog WARN "Could not stop PID $($p.Id) ($($p.Role)): $($_.Exception.Message)"
            }
        }
    }
    if ($WhatIfPreference) { return }

    Start-Sleep -Milliseconds 800
    # Ray may have spawned a new task worker between the scan and the kill: rescan until clean.
    $found = @((Get-TsOwnedProcesses -PythonEnv $PythonEnv).Processes)
} while ($found.Count -gt 0 -and (Get-Date) -lt $deadline)

if ($found.Count -gt 0) {
    Write-TsLog ERROR "$($found.Count) process(es) survived: $(($found | ForEach-Object { "$($_.Id) ($($_.Role))" }) -join ', ')."
    Write-TsLog ERROR 'They were probably started from an Administrator terminal. Re-run this script as Administrator.'
    exit 1
}

if ($Quiet) {
    Write-TsLog OK 'Previous run cleaned up.'
}
else {
    Write-TsLog OK "TensorSwarm stopped ($stopped process(es)). Nothing outside $PythonEnv was touched."
    Write-TsLog INFO 'If this was a worker, the Master marks it OFFLINE after ~15 s of missed heartbeats.'
}
