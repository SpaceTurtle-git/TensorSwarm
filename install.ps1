<#
.SYNOPSIS
    Installs TensorSwarm from the USB stick onto this PC's local disk (default C:\TensorSwarm),
    so the one stick can move on to the next PC. No internet needed, nothing else is installed.

.DESCRIPTION
    1. Copies the code (a few MB).
    2. Unpacks payload\python_env.tar.gz (one big file) to <dest>\python_env. This is skipped
       when the same build is already installed, so code updates take seconds.
    3. As Administrator: creates the Windows Firewall rules once (Tailscale peers only), so the
       start scripts never need admin again on this PC.
    4. Creates desktop shortcuts: TensorSwarm Master / Worker / Stop.
    Running from the local disk also starts much faster than running from a USB stick.

.EXAMPLE
    E:\TensorSwarm\install.cmd
.EXAMPLE
    .\install.ps1 -Destination D:\Tools\TensorSwarm -NoShortcuts
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Destination = 'C:\TensorSwarm',
    # Re-unpack the environment even if the same build is installed.
    [switch]$Force,
    [switch]$NoShortcuts,
    # Do not ask for Administrator rights (firewall rules are then not created).
    [switch]$NoElevate,
    # Internal: wait for Enter before closing (used by the elevated window).
    [switch]$PauseAtEnd
)

$ErrorActionPreference = 'Stop'
$Source = $PSScriptRoot
Import-Module (Join-Path $Source 'scripts\TensorSwarm.Common.psm1') -Force -DisableNameChecking

function Exit-Install([int]$Code) {
    if ($PauseAtEnd) { Write-Host ''; Read-Host 'Press Enter to close' | Out-Null }
    exit $Code
}

# ------------------------------------------------------------------------------
# 0. Ask for admin once (UAC prompt). Declined / no admin rights: continue as a normal user.
# ------------------------------------------------------------------------------
if (-not $NoElevate -and -not (Test-TsIsAdmin)) {
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Source 'install.ps1'),
                 '-Destination', $Destination, '-NoElevate', '-PauseAtEnd')
    if ($Force) { $argList += '-Force' }
    if ($NoShortcuts) { $argList += '-NoShortcuts' }
    try {
        Write-TsLog INFO 'Asking for Administrator rights (needed once, for the firewall rules) ...'
        $p = Start-Process -FilePath 'powershell.exe' -ArgumentList (ConvertTo-TsArgumentString $argList) -Verb RunAs -Wait -PassThru
        Write-TsLog INFO "The installation ran in the Administrator window (exit code $($p.ExitCode))."
        exit $p.ExitCode
    }
    catch {
        Write-TsLog WARN 'No Administrator rights (prompt declined or not allowed). Installing as a normal user.'
    }
}

Write-TsBanner 'TensorSwarm - Install to this PC'
$started = Get-Date

try {
    # --------------------------------------------------------------------------
    # 1. What are we installing from?
    # --------------------------------------------------------------------------
    $archive = $null; $buildId = $null
    foreach ($dir in @('payload', 'dist')) {   # payload\ on the stick, dist\ in the home copy
        $a = Join-Path $Source "$dir\python_env.tar.gz"; $b = Join-Path $Source "$dir\python_env.build.txt"
        if ((Test-Path -LiteralPath $a) -and (Test-Path -LiteralPath $b)) {
            $archive = $a; $buildId = (Get-Content -LiteralPath $b -Raw).Trim(); break
        }
    }
    $sourceEnv = Join-Path $Source 'python_env'
    if (-not $archive -and -not (Test-Path -LiteralPath (Join-Path $sourceEnv 'python.exe'))) {
        throw ("No environment found in $Source (payload\python_env.tar.gz is missing or incomplete).`n" +
               "        Re-create the stick at home with prepare_usb.cmd.")
    }
    if ($archive -and -not (Get-Command tar.exe -ErrorAction SilentlyContinue)) {
        throw 'tar.exe not found. This PC needs Windows 10 version 1803 or newer.'
    }

    # --------------------------------------------------------------------------
    # 2. Where to? Fall back to the user profile if C:\ is not writable (locked-down lab PCs).
    # --------------------------------------------------------------------------
    $Destination = [System.IO.Path]::GetFullPath($Destination)
    if ($Destination.TrimEnd('\') -ieq $Source.TrimEnd('\')) {
        throw "Already running from $Destination. Start TensorSwarm from here; nothing to install."
    }
    try {
        $null = New-Item -ItemType Directory -Force -Path $Destination
        $probe = Join-Path $Destination '.write_test'
        [System.IO.File]::WriteAllText($probe, 'ok'); Remove-Item -LiteralPath $probe -Force
    }
    catch {
        $fallback = Join-Path $env:LOCALAPPDATA 'TensorSwarm'
        Write-TsLog WARN "Cannot write to $Destination. Installing to $fallback instead."
        $Destination = $fallback
        $null = New-Item -ItemType Directory -Force -Path $Destination
    }
    $destEnv = Join-Path $Destination 'python_env'
    Write-TsLog INFO "From : $Source"
    Write-TsLog INFO "To   : $Destination"

    $installedId = $null
    $idFile = Join-Path $destEnv 'tensorswarm_build_id.txt'
    if (Test-Path -LiteralPath $idFile) { $installedId = (Get-Content -LiteralPath $idFile -Raw).Trim() }
    $needEnv = $Force -or -not (Test-Path -LiteralPath (Join-Path $destEnv 'python.exe')) -or -not $buildId -or ($installedId -ne $buildId)

    if ($needEnv) {
        $qualifier = Split-Path -Qualifier $Destination
        $vol = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$qualifier'" -ErrorAction SilentlyContinue
        if ($vol -and $vol.FreeSpace -lt 7GB) {
            throw ("Not enough space on {0}: need ~7 GB free, have {1:N1} GB. Use -Destination on another drive." -f $qualifier, ($vol.FreeSpace / 1GB))
        }
    }

    # --------------------------------------------------------------------------
    # 3. Stop a running copy at the destination (its files are about to be replaced).
    # --------------------------------------------------------------------------
    $destStop = Join-Path $Destination 'stop_tensorswarm.ps1'
    if ((Test-Path -LiteralPath $destStop) -and (Test-Path -LiteralPath (Join-Path $destEnv 'python.exe'))) {
        & $destStop -Quiet
    }

    # --------------------------------------------------------------------------
    # 4. Code. /MIR drops stale files; the excluded python_env, logs and .env are kept.
    # --------------------------------------------------------------------------
    Write-TsLog STEP 'Copying code ...'
    $exclDirs = Get-TsCodeCopyExclusions -Source $Source -Destination $Destination
    & robocopy.exe $Source $Destination /MIR /XD @exclDirs /XF .env '*.pyc' '*.partial' '.write_test' /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed copying the code (exit $LASTEXITCODE)." }
    Write-TsLog OK 'Code copied.'

    # --------------------------------------------------------------------------
    # 5. Environment.
    # --------------------------------------------------------------------------
    if (-not $needEnv) {
        Write-TsLog OK "Python environment is already installed (build $buildId). Skipped the unpack."
    }
    else {
        $staging = Join-Path $Destination '.python_env.new'
        if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
        $null = New-Item -ItemType Directory -Force -Path $staging
        $t = Get-Date
        if ($archive) {
            Write-TsLog STEP ("Unpacking the Python environment ({0:N1} GB, usually 2-5 min; no output until done) ..." -f ((Get-Item -LiteralPath $archive).Length / 1GB))
            & tar.exe -xzf $archive -C $staging
            if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE (archive damaged? Re-create the stick with prepare_usb.cmd)." }
        }
        else {
            Write-TsLog STEP 'Copying python_env folder (no archive on the stick, this is the slow path) ...'
            & robocopy.exe $sourceEnv (Join-Path $staging 'python_env') /E /MT:16 /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
            if ($LASTEXITCODE -ge 8) { throw "robocopy failed copying python_env (exit $LASTEXITCODE)." }
        }
        $newEnv = Join-Path $staging 'python_env'
        $newPython = Join-Path $newEnv 'python.exe'
        $countFile = Join-Path (Split-Path -Parent $archive) 'python_env.files.txt'
        if ($archive -and (Test-Path -LiteralPath $countFile)) {
            $expected = [int](Get-Content -LiteralPath $countFile -Raw).Trim()
            $got = @(Get-ChildItem -LiteralPath $newEnv -Recurse -File -Force -ErrorAction SilentlyContinue).Count
            if ($got -ne $expected) {
                throw "Unpacked $got of $expected files (bad USB read or disk full?). Re-run install.cmd; if it repeats, re-create the stick."
            }
        }
        Initialize-TsPythonEnvironment -PythonEnv $newEnv
        $check = Invoke-TsNative -FilePath $newPython -Arguments @('-c', 'import ray, torch, fastapi; print(ray.__version__, torch.__version__)')
        if ($check.ExitCode -ne 0) { throw 'The unpacked environment does not import ray/torch. Re-create the stick with prepare_usb.cmd.' }
        Write-TsLog OK ("Unpacked in {0:N0} s (Ray / torch: {1})." -f ((Get-Date) - $t).TotalSeconds, ($check.Output[-1]))

        # Swap in only after the new copy is verified, so a failed install never breaks a working one.
        if (Test-Path -LiteralPath $destEnv) {
            $old = Join-Path $Destination '.python_env.old'
            if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Recurse -Force }
            Move-Item -LiteralPath $destEnv -Destination $old
            Move-Item -LiteralPath $newEnv -Destination $destEnv
            Write-TsLog INFO 'Removing the previous environment ...'
            Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue
        }
        else {
            Move-Item -LiteralPath $newEnv -Destination $destEnv
        }
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
        if ($buildId) { [System.IO.File]::WriteAllText($idFile, $buildId) }
    }

    # --------------------------------------------------------------------------
    # 6. Firewall rules, once per PC (they point at C:\TensorSwarm, which never changes letter).
    # --------------------------------------------------------------------------
    if (Test-TsIsAdmin) {
        try {
            $count = Set-TsFirewallRules -PythonEnv $destEnv
            Write-TsLog OK "Windows Firewall: inbound allowed from Tailscale peers only for $count TensorSwarm executables."
        }
        catch { Write-TsLog WARN "Could not create firewall rules: $($_.Exception.Message)" }
    }
    elseif (Test-TsFirewallRulesPresent -PythonEnv $destEnv) {
        Write-TsLog OK 'Windows Firewall rules already exist on this PC.'
    }
    else {
        Write-TsLog WARN 'Not Administrator: firewall rules were not created. When Windows asks about python.exe /'
        Write-TsLog WARN 'raylet.exe / gcs_server.exe, click "Allow access", or re-run install.cmd and click Yes.'
    }

    # --------------------------------------------------------------------------
    # 6b. Shared data folder (Ray temp + datasets). As Administrator, let EVERY Windows user on
    #     this PC write to it, so a lab PC used by different accounts on different days can
    #     still update the dataset cache the previous user created.
    # --------------------------------------------------------------------------
    $tsData = Join-Path $(if ($env:ProgramData) { $env:ProgramData } else { 'C:\ProgramData' }) 'TensorSwarm'
    $null = New-Item -ItemType Directory -Force -Path (Join-Path $tsData 'datasets')
    if (Test-TsIsAdmin) {
        # *S-1-5-32-545 = BUILTIN\Users (language-independent); (OI)(CI)M = Modify, inherited.
        $null = & icacls.exe $tsData /grant '*S-1-5-32-545:(OI)(CI)M' /T /C /Q 2>&1
        if ($LASTEXITCODE -eq 0) { Write-TsLog OK "Shared data folder ready for all users: $tsData" }
        else { Write-TsLog WARN "Could not set permissions on $tsData (icacls exit $LASTEXITCODE)." }
    }

    # --------------------------------------------------------------------------
    # 6c. Datasets on the stick (prepare_usb.cmd -Datasets ...) -> this PC's dataset store.
    #     Workers then use them in place: no network transfer at all.
    # --------------------------------------------------------------------------
    $stickDatasets = Join-Path $Source 'datasets'
    if (Test-Path -LiteralPath $stickDatasets) {
        Write-TsLog STEP 'Copying datasets from the stick ...'
        & (Join-Path $destEnv 'python.exe') (Join-Path $Destination 'scripts\ts_dataset.py') seed $stickDatasets
        if ($LASTEXITCODE -ne 0) { Write-TsLog WARN "Some datasets were not copied (exit $LASTEXITCODE); they will download from the Master when used." }
    }

    # --------------------------------------------------------------------------
    # 7. Desktop shortcuts.
    # --------------------------------------------------------------------------
    if (-not $NoShortcuts) {
        try {
            $desktop = [Environment]::GetFolderPath('Desktop')
            $shell = New-Object -ComObject WScript.Shell
            $links = [ordered]@{
                'TensorSwarm Master' = @('master\start_master.cmd', 'Start the Master (orchestrator + this PC''s GPU worker)')
                'TensorSwarm Worker' = @('worker\start_worker.cmd', 'Join this PC''s GPU to the Master (asks for the Master IP)')
                'TensorSwarm Dashboard' = @('open_dashboard.cmd', 'Open the dashboard (notebook, jobs, cluster) served by the Master')
                'TensorSwarm Stop'   = @('stop_tensorswarm.cmd', 'Stop every TensorSwarm process on this PC')
            }
            foreach ($name in $links.Keys) {
                $lnk = $shell.CreateShortcut((Join-Path $desktop "$name.lnk"))
                $lnk.TargetPath = Join-Path $Destination $links[$name][0]
                $lnk.WorkingDirectory = Split-Path -Parent $lnk.TargetPath
                $lnk.Description = $links[$name][1]
                $lnk.Save()
            }
            Write-TsLog OK "Desktop shortcuts created: $($links.Keys -join ', ')"
        }
        catch { Write-TsLog WARN "Could not create desktop shortcuts: $($_.Exception.Message)" }
    }

    $minutes = [Math]::Round(((Get-Date) - $started).TotalMinutes, 1)
    Write-Host ''
    Write-Host ('=' * 70) -ForegroundColor Green
    Write-TsLog OK "TensorSwarm installed in $minutes min at $Destination"
    Write-Host ('=' * 70) -ForegroundColor Green
    Write-TsLog INFO 'You can unplug the USB stick now.'
    Write-TsLog INFO "  Master PC : 'TensorSwarm Master' shortcut  (= $(Join-Path $Destination 'master\start_master.cmd'))"
    Write-TsLog INFO "  Other PCs : 'TensorSwarm Worker' shortcut  (= $(Join-Path $Destination 'worker\start_worker.cmd') <MASTER_IP>)"
    Write-TsLog INFO "  Stop      : 'TensorSwarm Stop' shortcut"
}
catch {
    Write-Host ''
    Write-TsLog ERROR $_.Exception.Message
    Exit-Install 1
}
Exit-Install 0
