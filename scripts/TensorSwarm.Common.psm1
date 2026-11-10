<#
    TensorSwarm.Common.psm1
    Shared helpers for the Windows-native, run-from-USB scripts:
      build_usb_env.ps1, master\start_master.ps1, worker\start_worker.ps1, stop_tensorswarm.ps1

    Written for Windows PowerShell 5.1 (the version every Windows 10/11 PC ships with):
    no '??', no '&&', no ternaries.
#>
#Requires -Version 5.1

# ==============================================================================
# Console output
# ==============================================================================

function Write-TsLog {
    param(
        [Parameter(Mandatory = $true, Position = 0)]
        [ValidateSet('INFO', 'OK', 'WARN', 'ERROR', 'STEP')]
        [string]$Level,
        [Parameter(Mandatory = $true, Position = 1)]
        [AllowEmptyString()]
        [string]$Message
    )
    $colors = @{ INFO = 'Cyan'; OK = 'Green'; WARN = 'Yellow'; ERROR = 'Red'; STEP = 'Magenta' }
    Write-Host ('[{0}] ' -f (Get-Date -Format 'HH:mm:ss')) -NoNewline -ForegroundColor DarkGray
    Write-Host ('[{0,-5}] ' -f $Level) -NoNewline -ForegroundColor $colors[$Level]
    Write-Host $Message
}

function Write-TsBanner {
    param([Parameter(Mandatory = $true)][string]$Title)
    $line = '=' * 70
    Write-Host ''
    Write-Host $line -ForegroundColor Cyan
    Write-Host ('  ' + $Title) -ForegroundColor Cyan
    Write-Host $line -ForegroundColor Cyan
}

# ==============================================================================
# Native command helpers
# ==============================================================================

function Invoke-TsNative {
    <#
        Runs a native executable and captures stdout.
        Windows PowerShell 5.1 turns redirected stderr lines into terminating errors when
        $ErrorActionPreference = 'Stop', so the preference is relaxed inside this function only.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @()
    )
    $ErrorActionPreference = 'Continue'
    $output = & $FilePath @Arguments 2>$null
    $code = $LASTEXITCODE
    [pscustomobject]@{
        ExitCode = $code
        Output   = @($output | ForEach-Object { "$_" })
    }
}

function ConvertTo-TsArgumentString {
    <#
        Start-Process in PS 5.1 joins -ArgumentList with spaces and does NOT quote elements,
        so paths with spaces break. This applies standard Windows (CommandLineToArgvW) quoting.
    #>
    param([string[]]$Arguments)
    $quoted = foreach ($a in $Arguments) {
        if ($a -eq '') { '""' }
        elseif ($a -match '[\s"]') {
            $escaped = $a -replace '(\\*)"', '$1$1\"'
            $escaped = $escaped -replace '(\\+)$', '$1$1'
            '"' + $escaped + '"'
        }
        else { $a }
    }
    return ($quoted -join ' ')
}

# ==============================================================================
# Portable Python environment
# ==============================================================================

function Initialize-TsPythonEnvironment {
    <#
        Isolates the portable Python from whatever the host PC has installed and sets the
        variables Ray needs on Windows. Every child process (agent, Ray, uvicorn, and the
        Ray workers Ray spawns) inherits this environment.
    #>
    param([Parameter(Mandatory = $true)][string]$PythonEnv)

    # Host Python settings must never leak into the USB interpreter.
    foreach ($name in 'PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PYTHONEXECUTABLE',
                      'VIRTUAL_ENV', 'CONDA_PREFIX', 'CONDA_DEFAULT_ENV', 'PIP_REQUIRE_VIRTUALENV') {
        Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
    }
    $env:PYTHONNOUSERSITE = '1'   # ignore %APPDATA%\Python\...\site-packages on the host
    $env:PYTHONUNBUFFERED = '1'   # log lines reach the log files immediately
    $env:PYTHONUTF8 = '1'         # no cp1252 UnicodeEncodeError when output is redirected
    $env:PYTHONIOENCODING = 'utf-8'

    # Anything that shells out to "python" gets the USB interpreter first.
    $env:PATH = "$PythonEnv;$PythonEnv\Scripts;$env:PATH"

    # Ray refuses multi-node clusters on Windows unless this is set, and without it Ray also
    # pins the node IP to 127.0.0.1 (see ray/_private/ray_constants.py: ENABLE_RAY_CLUSTER).
    $env:RAY_ENABLE_WINDOWS_OR_OSX_CLUSTER = '1'
    $env:RAY_USAGE_STATS_ENABLED = '0'

    # College networks often force a system/env proxy. Tailscale traffic must go direct.
    $bypass = 'localhost,127.0.0.1,100.64.0.0/10,.ts.net'
    foreach ($name in 'NO_PROXY', 'no_proxy', 'no_grpc_proxy') {
        $current = [Environment]::GetEnvironmentVariable($name, 'Process')
        if ($current) { Set-Item -Path "Env:$name" -Value "$current,$bypass" }
        else { Set-Item -Path "Env:$name" -Value $bypass }
    }
    # Same for PowerShell's own health checks (Invoke-RestMethod) in this session.
    [System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy
}

function Assert-TsPython {
    param([Parameter(Mandatory = $true)][string]$PythonExe)
    if (-not (Test-Path -LiteralPath $PythonExe)) {
        $root = Split-Path -Parent (Split-Path -Parent $PythonExe)
        if (Test-Path -LiteralPath (Join-Path $root 'payload\python_env.tar.gz')) {
            throw ("This folder holds the packed environment but it is not installed yet.`n" +
                   "        Run $(Join-Path $root 'install.cmd') (it installs to C:\TensorSwarm in a few minutes), then start from there.")
        }
        throw ("Portable Python not found at '$PythonExe'.`n" +
               "        Build it at home with build_usb_env.cmd, then make the USB with prepare_usb.cmd.")
    }
    $probe = Invoke-TsNative -FilePath $PythonExe -Arguments @('-c', 'import sys, ray; print(sys.version.split()[0], ray.__version__)')
    if ($probe.ExitCode -ne 0 -or $probe.Output.Count -eq 0) {
        throw "The portable Python at '$PythonExe' could not import Ray. Re-run build_usb_env.cmd at home."
    }
    $parts = $probe.Output[-1].Split(' ')
    Write-TsLog OK ("Portable Python {0} with Ray {1}" -f $parts[0], $parts[1])
}

# ==============================================================================
# Tailscale
# ==============================================================================

function Test-TsIPv4 {
    param([string]$Value)
    if (-not $Value -or $Value -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { return $false }
    $parsed = $null
    return [System.Net.IPAddress]::TryParse($Value, [ref]$parsed)
}

function Test-TsTailscaleRange {
    # Tailscale hands out addresses from the CGNAT block 100.64.0.0/10.
    param([string]$Value)
    if (-not (Test-TsIPv4 $Value)) { return $false }
    $octets = $Value.Split('.') | ForEach-Object { [int]$_ }
    return ($octets[0] -eq 100 -and $octets[1] -ge 64 -and $octets[1] -le 127)
}

function Get-TsTailscaleExe {
    $cmd = Get-Command 'tailscale.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Path }
    $candidates = @()
    if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe') }
    if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Tailscale\tailscale.exe') }
    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c) { return $c }
    }
    return $null
}

function Get-TsTailscaleIPv4 {
    <# Returns this PC's Tailscale IPv4 via the native Windows CLI ("tailscale ip -4"). #>
    param([switch]$Interactive)
    $exe = Get-TsTailscaleExe
    if (-not $exe) {
        throw ("Tailscale is not installed on this PC.`n" +
               "        Install it from https://tailscale.com/download/windows, sign in with the swarm's account, then re-run.")
    }
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        $result = Invoke-TsNative -FilePath $exe -Arguments @('ip', '-4')
        $ip = $result.Output | ForEach-Object { $_.Trim() } | Where-Object { Test-TsIPv4 $_ } | Select-Object -First 1
        if ($result.ExitCode -eq 0 -and $ip) { return $ip }

        if (-not $Interactive -or $attempt -eq 2) { break }
        Write-TsLog WARN "Tailscale is installed but not connected. Running 'tailscale up' (a browser sign-in may open)..."
        $ErrorActionPreference = 'Continue'
        & $exe up
    }
    throw ("Could not read this PC's Tailscale IPv4 address.`n" +
           "        Open the Tailscale tray icon, make sure it says 'Connected', and check with: tailscale ip -4")
}

# ==============================================================================
# NVIDIA GPU detection (native Windows driver, no CUDA toolkit needed)
# ==============================================================================

function Get-TsNvidiaSmi {
    $cmd = Get-Command 'nvidia-smi.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Path }
    $candidates = @(
        (Join-Path $env:SystemRoot 'System32\nvidia-smi.exe'),                       # DCH drivers
        (Join-Path $env:ProgramFiles 'NVIDIA Corporation\NVSMI\nvidia-smi.exe')      # older drivers
    )
    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c) { return $c }
    }
    return $null
}

function Get-TsGpus {
    $smi = Get-TsNvidiaSmi
    if (-not $smi) { return @() }
    $result = Invoke-TsNative -FilePath $smi -Arguments @('--query-gpu=index,name,memory.total,driver_version', '--format=csv,noheader,nounits')
    if ($result.ExitCode -ne 0) { return @() }
    $gpus = foreach ($line in $result.Output) {
        $f = $line.Split(',') | ForEach-Object { $_.Trim() }
        if ($f.Count -ge 4) {
            [pscustomobject]@{ Index = $f[0]; Name = $f[1]; VramMB = $f[2]; Driver = $f[3] }
        }
    }
    return @($gpus)
}

function Test-TsDriverCompat {
    <# Warns when the host driver is too old for the CUDA runtime bundled in the USB's PyTorch. #>
    param([object[]]$Gpus, [Parameter(Mandatory = $true)][string]$PythonEnv)
    if (-not $Gpus -or $Gpus.Count -eq 0) { return }
    $manifestPath = Join-Path $PythonEnv 'tensorswarm_env.json'
    if (-not (Test-Path -LiteralPath $manifestPath)) { return }
    try { $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json } catch { return }
    $cudaProp = $manifest.PSObject.Properties['torch_cuda']
    if (-not $cudaProp -or -not $cudaProp.Value) { return }
    $cuda = [string]$cudaProp.Value

    # CUDA minor-version compatibility minimums for Windows drivers.
    $minimum = $null
    if ($cuda -like '12.*') { $minimum = [version]'527.41' }
    elseif ($cuda -like '11.*') { $minimum = [version]'452.39' }
    if (-not $minimum) { return }

    $driver = $null
    if (-not [version]::TryParse([string]$Gpus[0].Driver, [ref]$driver)) { return }
    if ($driver -lt $minimum) {
        Write-TsLog WARN ("NVIDIA driver {0} is older than {1}, which the USB's PyTorch (CUDA {2}) needs. GPU jobs will fail here." -f $driver, $minimum, $cuda)
        Write-TsLog WARN "Fix: update the driver, or rebuild the USB at home with: build_usb_env.cmd -Cuda cu118"
    }
}

# ==============================================================================
# Code copy (prepare_usb / install)
# ==============================================================================

function Get-TsCodeCopyExclusions {
    <#
        Folders robocopy must skip when copying the code. A bare name in /XD matches a folder
        of that name at ANY depth: 'datasets' also silently dropped master\dashboard\datasets
        (the Datasets page), so top-level folders are given as full paths, for the source and
        for the destination (the destination path also protects them from /MIR's purge).
        Only build/cache folders that are junk wherever they appear stay as bare names.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    $topLevel = @('python_env', 'wheelhouse', 'payload', 'dist', 'logs', '.venv', 'datasets', 'frontend\out', 'frontend\.api-parked')
    $anywhere = @('node_modules', '.next', '__pycache__', '.git')
    $list = New-Object System.Collections.Generic.List[string]
    foreach ($name in $topLevel) {
        $list.Add((Join-Path $Source $name))
        $list.Add((Join-Path $Destination $name))
    }
    foreach ($name in $anywhere) { $list.Add($name) }
    return , $list.ToArray()
}

# ==============================================================================
# Ray temp folder
# ==============================================================================

function Get-TsRayTempDir {
    <#
        Ray worker nodes always reuse the HEAD's temp-folder path (ray start ignores --temp-dir
        on workers). The default lives under the head's user profile (C:\Users\<name>\...), which
        does not exist on other PCs, so workers crash with "Access is denied: C:\Users\<name>".
        A user-independent path that exists on every Windows PC avoids that. Every node creates
        it before starting Ray.
    #>
    $base = $env:ProgramData
    if (-not $base) { $base = 'C:\ProgramData' }
    $dir = Join-Path $base 'TensorSwarm\ray'
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    return $dir
}

# ==============================================================================
# Windows Firewall
# ==============================================================================

function Test-TsIsAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Set-TsFirewallRules {
    <#
        Allows inbound TCP for the USB's python.exe, raylet.exe and gcs_server.exe, but ONLY
        from Tailscale peers (100.64.0.0/10). Rules are path-based, and the path contains the
        drive letter, so they are rebuilt on every start (stale rules from other letters are removed).
    #>
    param([Parameter(Mandatory = $true)][string]$PythonEnv)
    $group = 'TensorSwarm'
    $programs = @(Join-Path $PythonEnv 'python.exe')
    $rayCore = Join-Path $PythonEnv 'Lib\site-packages\ray\core'
    if (Test-Path -LiteralPath $rayCore) {
        $programs += @(Get-ChildItem -LiteralPath $rayCore -Recurse -Filter '*.exe' -File | ForEach-Object { $_.FullName })
    }

    Get-NetFirewallRule -Group $group -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue

    foreach ($program in $programs) {
        # If someone dismissed the "Windows Defender Firewall has blocked some features" popup,
        # Windows silently created an inbound BLOCK rule for this exact exe. Block beats Allow,
        # so remove those (only for our own USB executables).
        Get-NetFirewallApplicationFilter -Program $program -ErrorAction SilentlyContinue |
            Get-NetFirewallRule -ErrorAction SilentlyContinue |
            Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' } |
            Remove-NetFirewallRule -ErrorAction SilentlyContinue

        $leaf = Split-Path -Leaf $program
        New-NetFirewallRule -DisplayName "TensorSwarm $leaf (Tailscale peers only)" `
            -Group $group -Direction Inbound -Action Allow -Program $program `
            -Protocol TCP -RemoteAddress '100.64.0.0/10' -Profile Any `
            -Description 'Created by TensorSwarm start scripts. Remove with: Get-NetFirewallRule -Group TensorSwarm | Remove-NetFirewallRule' |
            Out-Null
    }
    return $programs.Count
}

function Test-TsFirewallRulesPresent {
    # Reading rules does not need admin. True when an Allow rule exists for THIS env's python.exe.
    param([Parameter(Mandatory = $true)][string]$PythonEnv)
    try {
        $python = Join-Path $PythonEnv 'python.exe'
        $rules = @(Get-NetFirewallRule -Group 'TensorSwarm' -ErrorAction Stop | Where-Object { $_.Enabled -eq 'True' -and $_.Action -eq 'Allow' })
        foreach ($r in $rules) {
            $prog = ($r | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue).Program
            if ($prog -and $prog -ieq $python) { return $true }
        }
    }
    catch { }
    return $false
}

function Initialize-TsFirewall {
    param([Parameter(Mandatory = $true)][string]$PythonEnv, [switch]$Skip)
    if ($Skip) {
        Write-TsLog WARN 'Skipping Windows Firewall configuration (-SkipFirewall).'
        return
    }
    if (Test-TsIsAdmin) {
        try {
            $count = Set-TsFirewallRules -PythonEnv $PythonEnv
            Write-TsLog OK "Windows Firewall: inbound allowed from Tailscale peers only (100.64.0.0/10) for $count USB executables."
        }
        catch {
            Write-TsLog WARN "Could not configure Windows Firewall: $($_.Exception.Message)"
        }
    }
    elseif (Test-TsFirewallRulesPresent -PythonEnv $PythonEnv) {
        Write-TsLog OK 'Windows Firewall: TensorSwarm rules already in place (created by install.cmd or an earlier admin run).'
    }
    else {
        Write-TsLog WARN 'Not running as Administrator, so Windows Firewall rules were NOT created.'
        Write-TsLog WARN "If a firewall popup appears for python.exe / raylet.exe / gcs_server.exe, click 'Allow access'."
        Write-TsLog WARN 'Other nodes cannot reach this PC until you do. Running once from an Administrator terminal fixes it for good.'
    }
}

# ==============================================================================
# Background processes, readiness checks, logs
# ==============================================================================

function Show-TsLogTail {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$LogDir,
        [int]$Lines = 25
    )
    foreach ($kind in 'err', 'out') {
        $path = Join-Path $LogDir "$Name.$kind.log"
        if (Test-Path -LiteralPath $path) {
            $tail = @(Get-Content -LiteralPath $path -Tail $Lines -ErrorAction SilentlyContinue)
            if ($tail.Count -gt 0) {
                Write-Host "----- $Name.$kind.log (last $Lines lines) -----" -ForegroundColor DarkYellow
                $tail | ForEach-Object { Write-Host "  $_" }
            }
        }
    }
}

function Start-TsBackgroundProcess {
    <#
        Launches a hidden, fully detached process (its own hidden console), so it keeps running
        if this terminal is closed, and captures stdout/stderr to logs\<role>\<Name>.{out,err}.log.
        Start-Process is used instead of Start-Job: jobs die with the PowerShell session that owns them.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$LogDir
    )
    if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
    $outLog = Join-Path $LogDir "$Name.out.log"
    $errLog = Join-Path $LogDir "$Name.err.log"
    foreach ($log in $outLog, $errLog) {
        if (Test-Path -LiteralPath $log) {
            try { Move-Item -LiteralPath $log -Destination "$log.prev" -Force }
            catch { throw "Log file '$log' is locked. An old TensorSwarm process is still running; run stop_tensorswarm.cmd first." }
        }
    }

    $proc = Start-Process -FilePath $FilePath `
        -ArgumentList (ConvertTo-TsArgumentString $Arguments) `
        -WorkingDirectory $WorkingDirectory `
        -WindowStyle Hidden `
        -RedirectStandardOutput $outLog `
        -RedirectStandardError $errLog `
        -PassThru
    $null = $proc.Handle   # PS 5.1 quirk: caching the handle keeps ExitCode readable later

    Start-Sleep -Milliseconds 1500
    if ($proc.HasExited) {
        Write-TsLog ERROR "$Name exited immediately (exit code $($proc.ExitCode))."
        Show-TsLogTail -Name $Name -LogDir $LogDir -Lines 30
        throw "$Name failed to start."
    }
    Write-TsLog OK ("{0,-10} started  PID {1,-6} log: {2}" -f $Name, $proc.Id, $errLog)
    return $proc
}

function Test-TsTcpPort {
    param([Parameter(Mandatory = $true)][string]$HostName, [Parameter(Mandatory = $true)][int]$Port, [int]$TimeoutMs = 1000)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect($HostName, $Port, $null, $null)
        if ($async.AsyncWaitHandle.WaitOne($TimeoutMs) -and $client.Connected) {
            $client.EndConnect($async)
            return $true
        }
        return $false
    }
    catch { return $false }
    finally { $client.Close() }
}

function Wait-TsTcpPort {
    param(
        [Parameter(Mandatory = $true)][string]$HostName,
        [Parameter(Mandatory = $true)][int]$Port,
        [int]$TimeoutSec = 60,
        [System.Diagnostics.Process]$Process
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-TsTcpPort -HostName $HostName -Port $Port) { return $true }
        if ($Process -and $Process.HasExited) { return $false }
        Start-Sleep -Milliseconds 750
    }
    return $false
}

function Wait-TsLogPattern {
    <# Waits until a log file contains a regex (e.g. "Ray runtime started"), or the process dies. #>
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Pattern,
        [int]$TimeoutSec = 90,
        [System.Diagnostics.Process]$Process
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if ((Test-Path -LiteralPath $Path) -and (Select-String -LiteralPath $Path -Pattern $Pattern -Quiet -ErrorAction SilentlyContinue)) {
            return $true
        }
        if ($Process -and $Process.HasExited) { return $false }
        Start-Sleep -Milliseconds 750
    }
    return $false
}

function Invoke-TsHealthCheck {
    param([Parameter(Mandatory = $true)][string]$Url, [int]$TimeoutSec = 3)
    try { return (Invoke-RestMethod -Uri $Url -TimeoutSec $TimeoutSec -ErrorAction Stop) }
    catch { return $null }
}

function Watch-TsLogs {
    <#
        Streams every service's log to the console with a coloured prefix.
        Ctrl+C only stops the streaming; the services keep running in the background.
        A name is either a log base name inside -LogDir ('agent') or 'label=C:\full\base\path'
        (e.g. 'worker=C:\TensorSwarm\logs\worker\ray-worker') to follow logs from another folder.
    #>
    param(
        [Parameter(Mandatory = $true)][string[]]$Names,
        [Parameter(Mandatory = $true)][string]$LogDir,
        [string]$StopHint
    )
    $palette = @('Cyan', 'Green', 'Yellow', 'Magenta', 'Blue')
    $files = @()
    $labels = @()
    for ($i = 0; $i -lt $Names.Count; $i++) {
        $label = $Names[$i]; $base = Join-Path $LogDir $Names[$i]
        if ($Names[$i] -match '^([^=]+)=(.+)$') { $label = $Matches[1]; $base = $Matches[2] }
        $labels += $label
        foreach ($kind in 'out', 'err') {
            $files += [pscustomobject]@{
                Name = $label; Path = "$base.$kind.log"
                Pos = [long]0; Partial = ''; Color = $palette[$i % $palette.Count]
            }
        }
    }
    $width = ($labels | Measure-Object -Property Length -Maximum).Maximum

    Write-Host ''
    Write-TsLog INFO 'Streaming live logs. Press Ctrl+C to stop streaming (TensorSwarm keeps running).'
    try {
        while ($true) {
            foreach ($f in $files) {
                if (-not (Test-Path -LiteralPath $f.Path)) { continue }
                try {
                    $fs = [System.IO.File]::Open($f.Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
                    try {
                        if ($fs.Length -lt $f.Pos) { $f.Pos = 0; $f.Partial = '' }   # file was replaced
                        if ($fs.Length -gt $f.Pos) {
                            $null = $fs.Seek($f.Pos, [System.IO.SeekOrigin]::Begin)
                            $reader = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
                            $text = $f.Partial + $reader.ReadToEnd()
                            $f.Pos = $fs.Position
                            $lines = $text -split "`r?`n"
                            $f.Partial = $lines[-1]
                            if ($lines.Count -gt 1) {
                                foreach ($line in $lines[0..($lines.Count - 2)]) {
                                    if ($line.Trim()) {
                                        Write-Host ($f.Name.PadRight($width) + ' | ') -NoNewline -ForegroundColor $f.Color
                                        Write-Host $line
                                    }
                                }
                            }
                        }
                    }
                    finally { $fs.Dispose() }
                }
                catch { }
            }
            Start-Sleep -Milliseconds 500
        }
    }
    finally {
        Write-Host ''
        Write-TsLog INFO 'Stopped streaming logs. TensorSwarm is still running in the background.'
        if ($StopHint) { Write-TsLog INFO $StopHint }
    }
}

# ==============================================================================
# Process discovery (used by stop_tensorswarm.ps1)
# ==============================================================================

function Get-TsProcessRole {
    param($Name, $CommandLine)
    $n = [string]$Name
    $cl = [string]$CommandLine
    if ($n -ieq 'raylet.exe') { return 'Ray raylet' }
    if ($n -ieq 'gcs_server.exe') { return 'Ray GCS server' }
    if ($cl -match '(?i)[\\/](master|worker)[\\/]agent\.py') { return 'Telemetry agent' }   # not ray\dashboard\agent.py
    if ($cl -match '(?i)uvicorn') { return 'FastAPI backend' }
    if ($cl -match '(?i)ray\.scripts\.scripts') { return 'Ray launcher' }
    if ($cl -match '(?i)default_worker\.py') { return 'Ray task worker' }
    if ($cl -match '(?i)dashboard') { return 'Ray dashboard' }
    if ($cl -match '(?i)[\\/]ray[\\/]') { return 'Ray service' }
    return 'Python (USB env)'
}

function Get-TsOwnedProcesses {
    <#
        Every TensorSwarm process runs an executable that lives inside the USB's python_env:
        python.exe for the agent / uvicorn / Ray launcher / Ray workers, and raylet.exe /
        gcs_server.exe under site-packages\ray. Matching on that path prefix means the user's
        own Python installs (C:\Python3x, Anaconda, the Microsoft Store Python...) are never touched.
    #>
    param([Parameter(Mandatory = $true)][string]$PythonEnv)
    $ignoreCase = [System.StringComparison]::OrdinalIgnoreCase
    $longPrefix = $PythonEnv.TrimEnd('\') + '\'
    # A process launched via an 8.3 path (C:\Users\JOHNDO~1\...) reports its ExecutablePath in that
    # form, while $PSScriptRoot may be the long form (or vice versa). Compare 8.3 forms as a fallback.
    $fso = New-Object -ComObject Scripting.FileSystemObject
    $shortPrefix = $longPrefix
    try { $shortPrefix = $fso.GetFolder($PythonEnv).ShortPath.TrimEnd('\') + '\' } catch { }

    $all = @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue)
    $owned = foreach ($p in $all) {
        $exe = [string]$p.ExecutablePath
        if (-not $exe) { continue }
        $isOwned = $exe.StartsWith($longPrefix, $ignoreCase) -or $exe.StartsWith($shortPrefix, $ignoreCase)
        if (-not $isOwned -and $p.Name -in @('python.exe', 'pythonw.exe', 'raylet.exe', 'gcs_server.exe')) {
            try { $isOwned = $fso.GetFile($exe).ShortPath.StartsWith($shortPrefix, $ignoreCase) } catch { }
        }
        if ($isOwned) {
            [pscustomobject]@{
                Id          = [int]$p.ProcessId
                Name        = $p.Name
                Role        = (Get-TsProcessRole -Name $p.Name -CommandLine $p.CommandLine)
                CommandLine = $p.CommandLine
            }
        }
    }
    # Processes started elevated are invisible (ExecutablePath = $null) to a non-elevated caller.
    $hidden = @($all | Where-Object { -not $_.ExecutablePath -and $_.Name -in @('python.exe', 'raylet.exe', 'gcs_server.exe') }).Count
    [pscustomobject]@{ Processes = @($owned); HiddenCount = $hidden }
}

Export-ModuleMember -Function *-Ts*
