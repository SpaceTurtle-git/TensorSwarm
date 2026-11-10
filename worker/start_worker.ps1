<#
.SYNOPSIS
    Connects this Windows laptop's GPU to the TensorSwarm Master, running entirely from the USB.
    No WSL, no Docker. The host PC only needs Tailscale and its normal NVIDIA driver.

.DESCRIPTION
    Starts two hidden background processes with the USB's portable python.exe:
      agent       worker\agent.py   PyNVML telemetry heartbeats -> Master FastAPI
      ray-worker  ray start --block Ray worker joined to the Master's Ray head
    They keep running if this window is closed. Stop them with stop_tensorswarm.cmd.
    The Master IP is remembered in worker\.env (same format the Linux/Docker scripts use).

.EXAMPLE
    E:\TensorSwarm\worker\start_worker.cmd 100.80.10.1
.EXAMPLE
    .\start_worker.ps1            # prompts for the Master IP (Enter = last one used)
.EXAMPLE
    C:\TensorSwarm\worker\start_worker.cmd -SameMachine
    Joins a Master running on THIS PC. start_master does this for you automatically; use it
    by hand only to restart the Master PC's worker without restarting the Master.
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$MasterIP,
    # Override auto-detection (tailscale ip -4).
    [string]$TailscaleIP,
    # GPUs this PC contributes to Ray. -1 = auto-detect with nvidia-smi.
    [int]$NumGpus = -1,
    # CPU cores this PC offers for jobs. -1 = all logical cores. Use fewer to keep the PC
    # responsive for whoever sits at it (e.g. -NumCpus 4 on an 8-core lab PC).
    [int]$NumCpus = -1,
    [int]$ApiPort = 8000,
    [int]$RayPort = 6379,
    [switch]$SkipFirewall,
    # Second Ray node on the Master PC itself (automatic when MasterIP is this PC's own IP).
    [switch]$SameMachine,
    # Return to the prompt after startup instead of streaming the logs.
    [switch]$NoFollow
)

$ErrorActionPreference = 'Stop'

# ------------------------------------------------------------------------------
# 1. Resolve every path from this script's own location (any drive letter works).
# ------------------------------------------------------------------------------
$WorkerDir  = $PSScriptRoot                       # <USB>\TensorSwarm\worker
$UsbRoot    = Split-Path -Parent $WorkerDir       # <USB>\TensorSwarm
$PythonEnv  = Join-Path $UsbRoot 'python_env'
$PythonExe  = Join-Path $PythonEnv 'python.exe'
$LogDir     = Join-Path $UsbRoot 'logs\worker'
$StopScript = Join-Path $UsbRoot 'stop_tensorswarm.ps1'
$EnvFile    = Join-Path $WorkerDir '.env'

Import-Module (Join-Path $UsbRoot 'scripts\TensorSwarm.Common.psm1') -Force -DisableNameChecking

function Get-SavedMasterIP {
    if (-not (Test-Path -LiteralPath $EnvFile)) { return $null }
    foreach ($line in Get-Content -LiteralPath $EnvFile) {
        if ($line -match '^\s*MASTER_TAILSCALE_IP\s*=\s*(\S+)\s*$') { return $Matches[1] }
    }
    return $null
}

Write-TsBanner 'TensorSwarm Worker Node - Windows Native'
Write-TsLog INFO "USB root        : $UsbRoot"
Write-TsLog INFO "Portable Python : $PythonExe"

try {
    Assert-TsPython -PythonExe $PythonExe
    Initialize-TsPythonEnvironment -PythonEnv $PythonEnv

    # --------------------------------------------------------------------------
    # 2. Clear leftovers from a previous run (only processes from this USB's python_env).
    # --------------------------------------------------------------------------
    #    Not in -SameMachine mode: that would kill the Master running on this PC.
    if (-not $SameMachine) { & $StopScript -Quiet }

    # --------------------------------------------------------------------------
    # 3. This worker's Tailscale IP via the native Windows CLI.
    # --------------------------------------------------------------------------
    if (-not $TailscaleIP) { $TailscaleIP = Get-TsTailscaleIPv4 -Interactive }
    elseif (-not (Test-TsIPv4 $TailscaleIP)) { throw "-TailscaleIP '$TailscaleIP' is not an IPv4 address." }
    Write-TsLog OK "Worker Tailscale IP: $TailscaleIP"

    # --------------------------------------------------------------------------
    # 4. Master IP: argument > $env:MASTER_TAILSCALE_IP > prompt (default = last used).
    # --------------------------------------------------------------------------
    if ($SameMachine -and -not $MasterIP) { $MasterIP = $TailscaleIP }
    if (-not $MasterIP -and $env:MASTER_TAILSCALE_IP) { $MasterIP = $env:MASTER_TAILSCALE_IP }
    if (-not $MasterIP) {
        $saved = Get-SavedMasterIP
        $prompt = "Enter the Master's Tailscale IP (e.g. 100.80.10.1)"
        if ($saved) { $prompt += " [Enter = $saved]" }
        $answer = (Read-Host $prompt).Trim()
        if ($answer) { $MasterIP = $answer } else { $MasterIP = $saved }
    }
    if (-not (Test-TsIPv4 $MasterIP)) { throw "Master IP '$MasterIP' is not a valid IPv4 address." }
    if ($MasterIP -eq $TailscaleIP -and -not $SameMachine) {
        Write-TsLog INFO 'Master IP is this PC''s own IP: joining the local Master (same-machine mode).'
        $SameMachine = $true
    }
    if (-not (Test-TsTailscaleRange $MasterIP)) { Write-TsLog WARN "$MasterIP is outside Tailscale's 100.64.0.0/10 range. Double-check it with 'tailscale status'." }
    Write-TsLog OK "Master Tailscale IP: $MasterIP"

    # --------------------------------------------------------------------------
    # 5. Reachability pre-flight, so problems show up here instead of deep in Ray's logs.
    # --------------------------------------------------------------------------
    Write-TsLog INFO "Checking the Master's Ray head at ${MasterIP}:$RayPort ..."
    if (-not (Wait-TsTcpPort -HostName $MasterIP -Port $RayPort -TimeoutSec 20)) {
        throw ("Cannot reach the Ray head at ${MasterIP}:$RayPort.`n" +
               "        - Is start_master running on the Master PC (in -SameMachine mode: on this PC, started first)?`n" +
               "        - Does 'tailscale ping $MasterIP' answer?`n" +
               "        - Was the Master started once as Administrator (firewall rules)?")
    }
    Write-TsLog OK 'Ray head is reachable.'
    if (Invoke-TsHealthCheck -Url "http://${MasterIP}:$ApiPort/healthz") { Write-TsLog OK 'Master FastAPI is reachable (telemetry will flow).' }
    else { Write-TsLog WARN "Master FastAPI at http://${MasterIP}:$ApiPort is not answering; heartbeats will retry every 5 s." }

    # --------------------------------------------------------------------------
    # 6. GPU detection through the host's native NVIDIA driver.
    # --------------------------------------------------------------------------
    $gpus = @(Get-TsGpus)
    if ($gpus.Count -gt 0) {
        foreach ($g in $gpus) { Write-TsLog OK ("GPU {0}: {1} ({2} MB, driver {3})" -f $g.Index, $g.Name, $g.VramMB, $g.Driver) }
        Test-TsDriverCompat -Gpus $gpus -PythonEnv $PythonEnv
    }
    else {
        Write-TsLog WARN 'No NVIDIA GPU detected (nvidia-smi not found or failed). This node joins as CPU-only.'
    }
    if ($NumGpus -lt 0) { $NumGpus = $gpus.Count }
    Write-TsLog INFO "GPUs offered to Ray from this PC: $NumGpus"
    if ($SameMachine -and $NumGpus -gt 0) {
        Write-TsLog INFO 'Same-machine mode: the Master''s Ray head claims 0 GPUs, so this worker owns the GPU.'
    }

    # --------------------------------------------------------------------------
    # 7. Windows Firewall: the head and other workers must reach this node's raylet,
    #    object manager and task-worker ports (Tailscale peers only).
    # --------------------------------------------------------------------------
    Initialize-TsFirewall -PythonEnv $PythonEnv -Skip:$SkipFirewall

    # Remember the Master for next time (same keys the Linux docker-compose flow writes).
    if (-not $SameMachine) {
        [System.IO.File]::WriteAllLines($EnvFile, [string[]]@(
            "MASTER_TAILSCALE_IP=$MasterIP",
            "WORKER_TAILSCALE_IP=$TailscaleIP",
            "MASTER_PORT=$ApiPort"
        ))
    }

    $env:MASTER_TAILSCALE_IP = $MasterIP
    $env:WORKER_TAILSCALE_IP = $TailscaleIP
    $env:MASTER_PORT         = "$ApiPort"
    $env:HEARTBEAT_INTERVAL  = '5'
    # One telemetry entry per PC (<hostname>-<ip>). The Master runs no agent of its own when
    # it has a local worker, so there is no collision on the Master PC.
    Remove-Item Env:NODE_ID -ErrorAction SilentlyContinue

    Write-Host ''
    Write-TsLog STEP 'Launching services ...'

    # --------------------------------------------------------------------------
    # 8. Telemetry agent (background).
    # --------------------------------------------------------------------------
    $agent = Start-TsBackgroundProcess -Name 'agent' -FilePath $PythonExe `
        -Arguments @('-u', (Join-Path $WorkerDir 'agent.py')) `
        -WorkingDirectory $WorkerDir -LogDir $LogDir

    # --------------------------------------------------------------------------
    # 9. Ray worker joined to the Master's head.
    # --------------------------------------------------------------------------
    $null = Get-TsRayTempDir   # the head tells workers to use this path; it must exist here too
    $rayArgs = @(
        '-m', 'ray.scripts.scripts', 'start',
        "--address=${MasterIP}:$RayPort",
        "--node-ip-address=$TailscaleIP",
        "--num-gpus=$NumGpus",
        "--num-cpus=$(if ($NumCpus -ge 0) { $NumCpus } else { [Environment]::ProcessorCount })",
        '--block'
    )
    if ($SameMachine) {
        # Second raylet on the same host: every fixed port must differ from the head's
        # (head uses dashboard agent 52365 and task-worker ports 20000-20050).
        $rayArgs += @(
            '--min-worker-port=20100', '--max-worker-port=20150',
            '--node-manager-port=20160', '--object-manager-port=20161',
            '--dashboard-agent-listen-port=52366', '--dashboard-agent-grpc-port=20162',
            '--runtime-env-agent-port=20163', '--metrics-export-port=20164'
        )
    }
    else {
        $rayArgs += @('--min-worker-port=20000', '--max-worker-port=20050')
    }
    $rayWorker = Start-TsBackgroundProcess -Name 'ray-worker' -FilePath $PythonExe -Arguments $rayArgs `
        -WorkingDirectory $WorkerDir -LogDir $LogDir

    Write-TsLog INFO 'Waiting for Ray to join the cluster (first start from USB can take ~30-60 s) ...'
    $joined = Wait-TsLogPattern -Path (Join-Path $LogDir 'ray-worker.out.log') -Pattern 'Ray runtime started' -TimeoutSec 150 -Process $rayWorker
    if (-not $joined) {
        Show-TsLogTail -Name 'ray-worker' -LogDir $LogDir -Lines 40
        $logText = ''
        foreach ($kind in 'err', 'out') {
            $lp = Join-Path $LogDir "ray-worker.$kind.log"
            if (Test-Path -LiteralPath $lp) { $logText += (Get-Content -LiteralPath $lp -Raw -ErrorAction SilentlyContinue) }
        }
        if ($logText -match '(?i)version mismatch|does not match the version') {
            throw "Ray worker did not join: this PC's Python/Ray build differs from the Master's. Install both from the same USB (install.cmd)."
        }
        if ($logText -match '(?i)Access is denied: .C:\\+Users') {
            throw ("Ray worker did not join: the Master told it to use a temp folder under another user's profile. " +
                   "Update the Master PC (prepare_usb.cmd -CodeOnly, then install.cmd) so it uses C:\ProgramData\TensorSwarm\ray.")
        }
        throw "Ray worker did not join the cluster. See the log lines above and the README troubleshooting table."
    }
    Write-TsLog OK "Ray worker joined the cluster at ${MasterIP}:$RayPort"

    if ($agent.HasExited) { throw "The telemetry agent exited during startup. See $LogDir\agent.err.log" }
}
catch {
    Write-Host ''
    Write-TsLog ERROR $_.Exception.Message
    Write-TsLog INFO "Logs: $LogDir   |   Ray internals: $env:TEMP\ray\session_latest\logs"
    if ($SameMachine) {
        # The stop script would also kill the Master; only stop what this run launched.
        foreach ($p in @($rayWorker, $agent)) { if ($p -and -not $p.HasExited) { try { Stop-Process -Id $p.Id -Force } catch { } } }
        Write-TsLog INFO 'If stray Ray processes remain, run stop_tensorswarm.cmd (stops the Master too).'
    }
    else {
        Write-TsLog INFO 'Cleaning up partially started services ...'
        try { & $StopScript -Quiet } catch { }
    }
    exit 1
}

# ------------------------------------------------------------------------------
# 10. Summary
# ------------------------------------------------------------------------------
$gpuLabel = 'CPU only'
if ($gpus.Count -gt 0) { $gpuLabel = ($gpus | ForEach-Object { $_.Name }) -join ', ' }
Write-Host ''
Write-Host ('=' * 70) -ForegroundColor Green
Write-TsLog OK  'TensorSwarm Worker is UP and connected (Windows native).'
Write-TsLog OK  "  Local GPU(s)  : $gpuLabel"
Write-TsLog OK  "  CPU cores     : $(if ($NumCpus -ge 0) { $NumCpus } else { [Environment]::ProcessorCount }) offered to the swarm"
Write-TsLog OK  "  Worker IP     : $TailscaleIP"
Write-TsLog OK  "  Master IP     : $MasterIP"
Write-TsLog OK  "  DASHBOARD     : http://${MasterIP}:$ApiPort   (notebook, jobs, cluster view)"
Write-TsLog OK  "  Ray dashboard : http://${MasterIP}:8265"
Write-TsLog OK  "  Service logs  : $LogDir"
Write-Host ('=' * 70) -ForegroundColor Green

$stopHint = "Disconnect this worker with: $(Join-Path $UsbRoot 'stop_tensorswarm.cmd')"
if ($SameMachine) { $stopHint += '  (same-machine mode: this also stops the Master)' }
if ($NoFollow) {
    Write-TsLog INFO $stopHint
}
else {
    Watch-TsLogs -Names @('agent', 'ray-worker') -LogDir $LogDir -StopHint $stopHint
}
exit 0
