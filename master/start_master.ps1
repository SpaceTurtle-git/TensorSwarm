<#
.SYNOPSIS
    Starts the TensorSwarm Master natively on Windows, entirely from the USB drive.
    No WSL, no Docker. The host PC only needs Tailscale and its normal NVIDIA driver.

.DESCRIPTION
    The Master is a pure orchestrator: the Ray head claims NO GPU. This PC's GPU is contributed
    by a normal worker that this script starts right after the head (same as on every other PC):
      ray-head  ray start --head --block   Ray head bound to this PC's Tailscale IP (0 GPUs)
      api       uvicorn server:app         FastAPI backend on port 8000
      + worker\start_worker.ps1 -SameMachine   agent + Ray worker owning this PC's GPU
    All run hidden in the background and keep running if this window is closed.
    Stop everything with stop_tensorswarm.cmd.

.EXAMPLE
    C:\TensorSwarm\master\start_master.cmd
.EXAMPLE
    .\start_master.ps1 -NoLocalWorker -NoFollow
    Orchestrator only (this PC's GPU is not used), and return to the prompt instead of streaming logs.
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    # Override auto-detection (tailscale ip -4).
    [string]$TailscaleIP,
    # GPUs the Ray HEAD claims. Keep 0: the local worker owns this PC's GPU.
    [int]$NumGpus = 0,
    # CPU cores the Ray HEAD offers for jobs. -1 = automatic: 0 when the local worker runs
    # (it offers this PC's cores, so they are not counted twice), all cores with -NoLocalWorker.
    [int]$NumCpus = -1,
    # Do not start the local worker (this PC then only orchestrates).
    [switch]$NoLocalWorker,
    # Kept for compatibility with older instructions; the head is always orchestrator-only now.
    [switch]$OrchestratorOnly,
    [int]$ApiPort = 8000,
    [int]$RayPort = 6379,
    [int]$RayClientPort = 10001,
    [int]$DashboardPort = 8265,
    [switch]$SkipFirewall,
    # Return to the prompt after startup instead of streaming the logs.
    [switch]$NoFollow
)

$ErrorActionPreference = 'Stop'

# ------------------------------------------------------------------------------
# 1. Resolve every path from this script's own location. Windows can mount the USB
#    as D:, E:, F: ... and nothing below cares.
# ------------------------------------------------------------------------------
$MasterDir  = $PSScriptRoot                       # <USB>\TensorSwarm\master
$UsbRoot    = Split-Path -Parent $MasterDir       # <USB>\TensorSwarm
$PythonEnv  = Join-Path $UsbRoot 'python_env'
$PythonExe  = Join-Path $PythonEnv 'python.exe'
$LogDir     = Join-Path $UsbRoot 'logs\master'
$StopScript = Join-Path $UsbRoot 'stop_tensorswarm.ps1'
$WorkerScript = Join-Path $UsbRoot 'worker\start_worker.ps1'
$WorkerLogDir = Join-Path $UsbRoot 'logs\worker'

Import-Module (Join-Path $UsbRoot 'scripts\TensorSwarm.Common.psm1') -Force -DisableNameChecking

Write-TsBanner 'TensorSwarm Master Node - Windows Native'
Write-TsLog INFO "USB root        : $UsbRoot"
Write-TsLog INFO "Portable Python : $PythonExe"

try {
    Assert-TsPython -PythonExe $PythonExe
    Initialize-TsPythonEnvironment -PythonEnv $PythonEnv

    # --------------------------------------------------------------------------
    # 2. Clear leftovers from a previous run (only processes from this USB's python_env).
    # --------------------------------------------------------------------------
    & $StopScript -Quiet

    # --------------------------------------------------------------------------
    # 3. Tailscale IP via the native Windows CLI.
    # --------------------------------------------------------------------------
    if (-not $TailscaleIP) { $TailscaleIP = Get-TsTailscaleIPv4 -Interactive }
    elseif (-not (Test-TsIPv4 $TailscaleIP)) { throw "-TailscaleIP '$TailscaleIP' is not an IPv4 address." }
    Write-TsLog OK "Master Tailscale IP: $TailscaleIP"

    # --------------------------------------------------------------------------
    # 4. GPU detection through the host's native NVIDIA driver.
    # --------------------------------------------------------------------------
    $gpus = @(Get-TsGpus)
    if ($gpus.Count -gt 0) {
        foreach ($g in $gpus) { Write-TsLog OK ("GPU {0}: {1} ({2} MB, driver {3})" -f $g.Index, $g.Name, $g.VramMB, $g.Driver) }
        Test-TsDriverCompat -Gpus $gpus -PythonEnv $PythonEnv
    }
    else {
        Write-TsLog WARN 'No NVIDIA GPU detected (nvidia-smi not found or failed). The Master will orchestrate on CPU only.'
    }
    if ($NumGpus -lt 0) { $NumGpus = $gpus.Count }
    if ($NumGpus -eq 0) {
        if ($NoLocalWorker) { Write-TsLog INFO 'Ray head is orchestrator-only (0 GPUs). This PC''s GPU is not used (-NoLocalWorker).' }
        else { Write-TsLog INFO 'Ray head is orchestrator-only (0 GPUs). The local worker started below owns this PC''s GPU.' }
    }
    else {
        Write-TsLog WARN "Ray head claims $NumGpus GPU(s). With the local worker too, Ray counts this PC's GPU twice. Use -NoLocalWorker or leave -NumGpus at 0."
    }

    # --------------------------------------------------------------------------
    # 5. Windows Firewall (Tailscale peers only).
    # --------------------------------------------------------------------------
    Initialize-TsFirewall -PythonEnv $PythonEnv -Skip:$SkipFirewall

    # Environment inherited by every child process.
    $env:MASTER_TAILSCALE_IP = $TailscaleIP
    $env:WORKER_TAILSCALE_IP = $TailscaleIP   # the Master's own agent reports this node's IP
    $env:MASTER_PORT         = "$ApiPort"
    $env:HEARTBEAT_INTERVAL  = '5'

    Write-Host ''
    Write-TsLog STEP 'Launching services ...'

    # --------------------------------------------------------------------------
    # 6. Telemetry agent: only without a local worker. Otherwise the worker's agent reports
    #    this PC, so the dashboard shows each PC once.
    # --------------------------------------------------------------------------
    $agent = $null
    if ($NoLocalWorker) {
        $agent = Start-TsBackgroundProcess -Name 'agent' -FilePath $PythonExe `
            -Arguments @('-u', (Join-Path $MasterDir 'agent.py')) `
            -WorkingDirectory $MasterDir -LogDir $LogDir
    }

    # --------------------------------------------------------------------------
    # 7. Ray head, bound to the Tailscale IP.
    #    "python -m ray.scripts.scripts" instead of Scripts\ray.exe: pip's .exe launchers
    #    hard-code the drive letter the USB had when the env was built.
    # --------------------------------------------------------------------------
    $RayTempDir = Get-TsRayTempDir
    $HeadCpus = $NumCpus
    if ($HeadCpus -lt 0) {
        if ($NoLocalWorker) { $HeadCpus = [Environment]::ProcessorCount } else { $HeadCpus = 0 }
    }
    if ($HeadCpus -gt 0) { Write-TsLog INFO "Ray head offers $HeadCpus CPU core(s) of this PC for CPU jobs." }
    else { Write-TsLog INFO 'Ray head offers no CPU cores (the local worker offers this PC''s cores).' }
    $rayArgs = @(
        '-m', 'ray.scripts.scripts', 'start', '--head',
        "--node-ip-address=$TailscaleIP",
        "--temp-dir=$RayTempDir",
        "--port=$RayPort",
        "--ray-client-server-port=$RayClientPort",
        '--dashboard-host=0.0.0.0',
        "--dashboard-port=$DashboardPort",
        '--min-worker-port=20000',
        '--max-worker-port=20050',
        "--num-gpus=$NumGpus",
        "--num-cpus=$HeadCpus",
        '--disable-usage-stats',
        '--block'
    )
    $rayHead = Start-TsBackgroundProcess -Name 'ray-head' -FilePath $PythonExe -Arguments $rayArgs `
        -WorkingDirectory $MasterDir -LogDir $LogDir

    Write-TsLog INFO "Waiting for the Ray GCS on ${TailscaleIP}:$RayPort (first start from USB can take ~30-60 s) ..."
    if (-not (Wait-TsTcpPort -HostName $TailscaleIP -Port $RayPort -TimeoutSec 150 -Process $rayHead)) {
        Show-TsLogTail -Name 'ray-head' -LogDir $LogDir -Lines 40
        throw "Ray head did not come up on ${TailscaleIP}:$RayPort."
    }
    Write-TsLog OK "Ray head is listening on ${TailscaleIP}:$RayPort"
    if (Wait-TsTcpPort -HostName $TailscaleIP -Port $RayClientPort -TimeoutSec 60 -Process $rayHead) {
        Write-TsLog OK "Ray client server is listening on ${TailscaleIP}:$RayClientPort"
    }
    else {
        Write-TsLog WARN "Ray client port $RayClientPort is not open yet; the API will keep retrying in the background."
    }

    # --------------------------------------------------------------------------
    # 8. FastAPI backend (background).
    # --------------------------------------------------------------------------
    $api = Start-TsBackgroundProcess -Name 'api' -FilePath $PythonExe `
        -Arguments @('-m', 'uvicorn', 'server:app', '--app-dir', $MasterDir, '--host', '0.0.0.0', '--port', "$ApiPort") `
        -WorkingDirectory $MasterDir -LogDir $LogDir

    $healthUrl = "http://127.0.0.1:$ApiPort/healthz"
    Write-TsLog INFO "Waiting for $healthUrl ..."
    $health = $null
    $deadline = (Get-Date).AddSeconds(90)
    while (-not $health -and (Get-Date) -lt $deadline -and -not $api.HasExited) {
        $health = Invoke-TsHealthCheck -Url $healthUrl
        if (-not $health) { Start-Sleep -Seconds 1 }
    }
    if (-not $health) {
        Show-TsLogTail -Name 'api' -LogDir $LogDir -Lines 40
        throw "FastAPI backend did not become healthy at $healthUrl."
    }
    Write-TsLog OK 'FastAPI backend is healthy.'

    # The API connects to Ray in the background; give it a moment so we can report the result.
    $deadline = (Get-Date).AddSeconds(45)
    while (-not $health.ray_connected -and (Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        $probe = Invoke-TsHealthCheck -Url $healthUrl
        if ($probe) { $health = $probe }
    }
    if ($health.ray_connected) { Write-TsLog OK 'FastAPI backend is connected to the Ray cluster.' }
    else { Write-TsLog WARN 'FastAPI is up but not connected to Ray yet. It retries automatically when a job is submitted.' }

    foreach ($p in @($agent, $rayHead, $api)) {
        if ($p -and $p.HasExited) { throw "A service exited during startup (PID $($p.Id)). See logs in $LogDir." }
    }
}
catch {
    Write-Host ''
    Write-TsLog ERROR $_.Exception.Message
    Write-TsLog INFO "Logs: $LogDir   |   Ray internals: $env:TEMP\ray\session_latest\logs"
    Write-TsLog INFO 'Cleaning up partially started services ...'
    try { & $StopScript -Quiet } catch { }
    exit 1
}

# ------------------------------------------------------------------------------
# 9. Local worker: contributes this PC's GPU through a normal Ray worker node.
#    A failure here does not take the Master down.
# ------------------------------------------------------------------------------
$localWorkerUp = $false
if (-not $NoLocalWorker) {
    Write-Host ''
    Write-TsLog STEP 'Starting the local worker (this PC''s GPU) ...'
    & $WorkerScript -MasterIP $TailscaleIP -TailscaleIP $TailscaleIP -SameMachine -SkipFirewall -NoFollow `
        -ApiPort $ApiPort -RayPort $RayPort
    $localWorkerUp = ($LASTEXITCODE -eq 0)
    if (-not $localWorkerUp) {
        Write-TsLog WARN "The local worker failed (see $WorkerLogDir). The Master keeps running; retry with: $(Join-Path $UsbRoot 'worker\start_worker.cmd') -SameMachine"
    }
}

# ------------------------------------------------------------------------------
# 10. Summary
# ------------------------------------------------------------------------------
Write-Host ''
Write-Host ('=' * 70) -ForegroundColor Green
Write-TsLog OK  'TensorSwarm Master is UP (Windows native).'
Write-TsLog OK  "  Tailscale IP      : $TailscaleIP"
Write-TsLog OK  "  DASHBOARD         : http://${TailscaleIP}:$ApiPort   (open from ANY PC on the tailnet)"
Write-TsLog OK  "  FastAPI docs      : http://${TailscaleIP}:$ApiPort/docs"
Write-TsLog OK  "  Ray dashboard     : http://${TailscaleIP}:$DashboardPort"
Write-TsLog OK  "  Ray client address: ray://${TailscaleIP}:$RayClientPort"
Write-TsLog OK  "  Service logs      : $LogDir"
if ($localWorkerUp) { Write-TsLog OK  "  Local worker      : UP (this PC's GPU)   logs: $WorkerLogDir" }
Write-Host ('=' * 70) -ForegroundColor Green
Write-TsLog INFO 'On every other PC (after install.cmd):'
Write-TsLog INFO "  C:\TensorSwarm\worker\start_worker.cmd $TailscaleIP"
Write-TsLog INFO 'Linux/Docker workers:'
Write-TsLog INFO "  sudo ./start_worker.sh $TailscaleIP"

$stopHint = "Stop everything with: $(Join-Path $UsbRoot 'stop_tensorswarm.cmd')"
if ($NoFollow) {
    Write-TsLog INFO $stopHint
}
else {
    $streams = @('ray-head', 'api')
    if ($agent) { $streams += 'agent' }
    if ($localWorkerUp) {
        $streams += @("w-agent=$(Join-Path $WorkerLogDir 'agent')", "w-ray=$(Join-Path $WorkerLogDir 'ray-worker')")
    }
    Watch-TsLogs -Names $streams -LogDir $LogDir -StopHint $stopHint
}
exit 0
