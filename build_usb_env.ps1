<#
.SYNOPSIS
    Builds TensorSwarm's portable Python environment (python_env\) next to this script.
    Run this ONCE, at home, on a fast connection, in the project folder on your PC's own disk
    (much faster than on a stick). Then run prepare_usb.cmd to write the installer USB.

.DESCRIPTION
    1. Puts a relocatable CPython 3.10 in  <USB>\TensorSwarm\python_env\
         - default: python-build-standalone "install_only" build (~30 MB), downloaded with
           resumable curl.exe
         - or:      copy an already-extracted WinPython folder (-WinPythonDir)
    2. Downloads every wheel (PyTorch+CUDA, Ray, FastAPI, NVML...) into <USB>\TensorSwarm\wheelhouse\
       with --default-timeout=1000 and an outer retry loop. Finished wheels are kept, so a dropped
       connection only costs the wheel that was in flight.
    3. Installs everything OFFLINE from the wheelhouse into python_env (no venv: a venv hard-codes
       the drive letter in pyvenv.cfg and breaks when Windows assigns the USB a different letter).
    4. Verifies the imports and writes python_env\tensorswarm_env.json + tensorswarm-freeze.txt.

.EXAMPLE
    E:\TensorSwarm\build_usb_env.cmd
.EXAMPLE
    .\build_usb_env.ps1 -Cuda cu118
    For lab PCs whose NVIDIA driver is older than 527.41 (CUDA 12 builds need >= 527.41).
.EXAMPLE
    .\build_usb_env.ps1 -WinPythonDir "D:\Downloads\WPy64-310111\python-3.10.11.amd64"
.EXAMPLE
    .\build_usb_env.ps1 -PythonVersion 3.10.14 -StandaloneRelease 20240814
    Match the exact Python patch version of Linux/Docker nodes in a mixed cluster.
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    # Exact CPython release. Ray 2.35 requires the SAME patch version on every node of a cluster.
    [string]$PythonVersion = '3.10.15',
    # python-build-standalone release tag that contains $PythonVersion.
    [string]$StandaloneRelease = '20241016',
    # Optional: use an extracted WinPython instead (the folder that contains python.exe,
    # or the WPy64-xxxx root that contains python-3.10.x.amd64\).
    [string]$WinPythonDir,
    # cu121 suits GTX 16xx / RTX 20xx/30xx/40xx with drivers >= 527.41. cu118 for older drivers.
    [ValidateSet('cu118', 'cu121', 'cu124', 'cpu')]
    [string]$Cuda = 'cu121',
    [string]$TorchVersion = '2.5.1',
    [string]$TorchvisionVersion = '0.20.1',
    # How many times each download phase is retried on a flaky connection.
    [ValidateRange(1, 50)]
    [int]$Attempts = 8,
    [switch]$SkipTorch,
    # Wipe python_env and rebuild from scratch (the wheelhouse is kept).
    [switch]$Clean,
    # Delete the wheelhouse after a successful install (saves ~3 GB, loses offline repair).
    [switch]$PruneWheelhouse
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest's progress bar is extremely slow in PS 5.1

# ------------------------------------------------------------------------------
# Paths: everything is relative to this script, so any drive letter works.
# ------------------------------------------------------------------------------
$UsbRoot      = $PSScriptRoot
$PythonEnv    = Join-Path $UsbRoot 'python_env'
$PythonExe    = Join-Path $PythonEnv 'python.exe'
$Wheelhouse   = Join-Path $UsbRoot 'wheelhouse'
$Requirements = @((Join-Path $UsbRoot 'master\requirements.txt'), (Join-Path $UsbRoot 'worker\requirements.txt'))
$ExtraPins    = @('numpy<2')   # conservative pin for Ray 2.35 + torch 2.5 compatibility

Import-Module (Join-Path $UsbRoot 'scripts\TensorSwarm.Common.psm1') -Force -DisableNameChecking

# THE pip timeout fix. pypi.nvidia.com / download.pytorch.org stall for long stretches on slow links;
# pip's default 15 s read timeout kills a 2.5 GB wheel download. 1000 s rides out those stalls.
$PipNetworkArgs = @('--default-timeout=1000', '--retries', '10', '--progress-bar', 'on', '--disable-pip-version-check')

function Invoke-PipWithRetry {
    param(
        [Parameter(Mandatory = $true)][string]$Description,
        [Parameter(Mandatory = $true)][string[]]$PipArgs,
        [int]$MaxAttempts = $Attempts
    )
    for ($i = 1; $i -le $MaxAttempts; $i++) {
        Write-TsLog STEP "$Description (attempt $i/$MaxAttempts)"
        Write-Host ("  > python -m pip " + ($PipArgs -join ' ')) -ForegroundColor DarkGray
        & $PythonExe -m pip @PipArgs
        if ($LASTEXITCODE -eq 0) { return }
        if ($i -lt $MaxAttempts) {
            $delay = [Math]::Min(60, 10 * $i)
            Write-TsLog WARN "pip exited with code $LASTEXITCODE. Completed wheels are kept in wheelhouse\. Retrying in $delay s..."
            Start-Sleep -Seconds $delay
        }
    }
    throw "$Description failed after $MaxAttempts attempts. Just re-run build_usb_env.cmd: it resumes where it stopped."
}

function Get-FolderSizeGB {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    $sum = (Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    return [Math]::Round(($sum / 1GB), 2)
}

function Test-BuildPrerequisites {
    Write-TsLog INFO "USB root  : $UsbRoot"
    Write-TsLog INFO "Target    : $PythonEnv"
    Write-TsLog INFO "Wheelhouse: $Wheelhouse"
    Write-TsLog INFO ("PyTorch   : " + $(if ($SkipTorch) { 'skipped (-SkipTorch)' } else { "$TorchVersion+$Cuda / torchvision $TorchvisionVersion+$Cuda" }))

    foreach ($req in $Requirements) {
        if (-not (Test-Path -LiteralPath $req)) { throw "Missing $req. Copy the whole TensorSwarm folder to the USB first." }
    }

    # Drive checks (best effort: Get-Volume is unavailable for network paths).
    $qualifier = Split-Path -Qualifier $UsbRoot -ErrorAction SilentlyContinue
    if ($qualifier) {
        try {
            $vol = Get-Volume -DriveLetter $qualifier.TrimEnd(':') -ErrorAction Stop
            $freeGB = [Math]::Round($vol.SizeRemaining / 1GB, 1)
            Write-TsLog INFO "Drive $qualifier : $($vol.FileSystem), $freeGB GB free"
            if ($freeGB -lt 12) { Write-TsLog WARN 'Less than 12 GB free. A full CUDA build needs ~6 GB (python_env) + ~3 GB (wheelhouse) + headroom.' }
            if ($vol.FileSystem -match 'FAT') {
                Write-TsLog WARN "$($vol.FileSystem) is slow with the ~60,000 small files of a Python env. Formatting the USB as NTFS is strongly recommended."
            }
        }
        catch { }
    }

    if ($UsbRoot.Length -gt 40) {
        $longPaths = 0
        try { $longPaths = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -ErrorAction Stop).LongPathsEnabled } catch { }
        if ($longPaths -ne 1) {
            Write-TsLog WARN "Path '$UsbRoot' is long and Windows long paths are disabled. Keep TensorSwarm at the USB root (e.g. E:\TensorSwarm) to stay under MAX_PATH."
        }
    }
}

function Install-PortablePython {
    if ((Test-Path -LiteralPath $PythonExe) -and -not $Clean) {
        Write-TsLog OK "Reusing existing portable Python at $PythonExe (use -Clean to rebuild)."
        return
    }
    if (Test-Path -LiteralPath $PythonEnv) {
        Write-TsLog WARN 'Removing old python_env ...'
        Remove-Item -LiteralPath $PythonEnv -Recurse -Force
    }

    if ($WinPythonDir) {
        $source = $WinPythonDir
        if (-not (Test-Path -LiteralPath (Join-Path $source 'python.exe'))) {
            $inner = Get-ChildItem -LiteralPath $source -Directory -Filter 'python-*' -ErrorAction SilentlyContinue |
                Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'python.exe') } | Select-Object -First 1
            if (-not $inner) { throw "No python.exe found in '$WinPythonDir' or its python-* subfolder." }
            $source = $inner.FullName
        }
        Write-TsLog STEP "Copying WinPython from $source ..."
        & robocopy.exe $source $PythonEnv /E /NFL /NDL /NJH /NJS /NP /R:2 /W:2 | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE." }
        $global:LASTEXITCODE = 0   # robocopy uses 1-7 for success
    }
    else {
        $fileName = "cpython-$PythonVersion+$StandaloneRelease-x86_64-pc-windows-msvc-install_only.tar.gz"
        $url = "https://github.com/astral-sh/python-build-standalone/releases/download/$StandaloneRelease/$fileName"
        if (-not (Test-Path -LiteralPath $Wheelhouse)) { New-Item -ItemType Directory -Path $Wheelhouse | Out-Null }
        $archive = Join-Path $Wheelhouse $fileName   # kept on the USB for offline rebuilds

        $archiveOk = (Test-Path -LiteralPath $archive) -and ((Invoke-TsNative -FilePath 'tar.exe' -Arguments @('-tzf', $archive)).ExitCode -eq 0)
        if (-not $archiveOk) {
            Write-TsLog STEP "Downloading portable CPython $PythonVersion (~30 MB)"
            Write-Host "  > $url" -ForegroundColor DarkGray
            $curl = Get-Command 'curl.exe' -ErrorAction SilentlyContinue
            for ($i = 1; $i -le $Attempts -and -not $archiveOk; $i++) {
                if ($curl) {
                    # -C - resumes a partial file instead of starting over.
                    & $curl.Path --fail --location --retry 5 --retry-delay 5 --connect-timeout 30 -C - --output $archive $url
                }
                else {
                    Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing
                }
                $archiveOk = (Test-Path -LiteralPath $archive) -and ((Invoke-TsNative -FilePath 'tar.exe' -Arguments @('-tzf', $archive)).ExitCode -eq 0)
                if (-not $archiveOk -and $i -lt $Attempts) {
                    Write-TsLog WARN "Download incomplete, resuming (attempt $($i + 1)/$Attempts) ..."
                    Start-Sleep -Seconds 5
                }
            }
            if (-not $archiveOk) { throw "Could not download $url" }
        }

        Write-TsLog STEP 'Extracting portable CPython ...'
        $staging = Join-Path $UsbRoot 'python_env.extract'
        if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
        New-Item -ItemType Directory -Path $staging | Out-Null
        & tar.exe -xzf $archive -C $staging
        if ($LASTEXITCODE -ne 0) { throw 'tar.exe failed to extract the CPython archive.' }
        Move-Item -LiteralPath (Join-Path $staging 'python') -Destination $PythonEnv
        Remove-Item -LiteralPath $staging -Recurse -Force
    }

    if (-not (Test-Path -LiteralPath $PythonExe)) { throw "python.exe not found in $PythonEnv after setup." }
}

function Assert-PythonVersion {
    $probe = Invoke-TsNative -FilePath $PythonExe -Arguments @('-c', 'import sys; print(sys.version.split()[0])')
    $actual = ($probe.Output | Select-Object -Last 1)
    if (-not $actual) { throw "Portable python.exe does not run: $PythonExe" }
    Write-TsLog OK "Portable Python $actual ready."
    $v = [version]$actual
    if ($v.Major -ne 3 -or $v.Minor -lt 9 -or $v.Minor -gt 12) {
        throw "Python $actual is not supported by Ray 2.35 on Windows (needs 3.9 - 3.12; 3.10 recommended)."
    }
    if ($actual -ne $PythonVersion) {
        Write-TsLog WARN "Python is $actual (not $PythonVersion). Fine for an all-USB swarm built from this same USB image,"
        Write-TsLog WARN 'but Ray 2.35 rejects nodes whose Python patch version differs from the head node.'
    }
}

# ==============================================================================
# Main
# ==============================================================================
Write-TsBanner 'TensorSwarm - Build Portable USB Environment (run at home)'
$started = Get-Date

try {
    Test-BuildPrerequisites
    Initialize-TsPythonEnvironment -PythonEnv $PythonEnv   # isolates from any host Python/pip config

    # --- 1. Portable interpreter -------------------------------------------------
    Install-PortablePython
    Assert-PythonVersion

    # --- 2. pip ------------------------------------------------------------------
    if ((Invoke-TsNative -FilePath $PythonExe -Arguments @('-m', 'pip', '--version')).ExitCode -ne 0) {
        Write-TsLog STEP 'Bootstrapping pip (offline, via ensurepip) ...'
        & $PythonExe -m ensurepip --upgrade
        if ($LASTEXITCODE -ne 0) { throw 'ensurepip failed.' }
    }
    Invoke-PipWithRetry -Description 'Upgrading pip' -PipArgs (@('install', '--upgrade', 'pip', '--no-warn-script-location') + $PipNetworkArgs)

    # pip >= 25.1 can resume a half-downloaded wheel instead of restarting it.
    $pipHelp = Invoke-TsNative -FilePath $PythonExe -Arguments @('-m', 'pip', 'download', '--help')
    if ($pipHelp.Output -match '--resume-retries') {
        $PipNetworkArgs += @('--resume-retries', '20')
        Write-TsLog OK 'pip supports --resume-retries: interrupted wheel downloads resume mid-file.'
    }

    if (-not (Test-Path -LiteralPath $Wheelhouse)) { New-Item -ItemType Directory -Path $Wheelhouse | Out-Null }
    $reqArgs = @()
    foreach ($r in $Requirements) { $reqArgs += @('-r', $r) }
    $torchPkgs = @("torch==$TorchVersion+$Cuda", "torchvision==$TorchvisionVersion+$Cuda")

    # --- 3. Download phase (online, resumable) -----------------------------------
    if (-not $SkipTorch) {
        # On Windows the CUDA runtime/cuDNN DLLs ship INSIDE the torch wheel, so the host only
        # needs the normal NVIDIA display driver: no CUDA toolkit, no nvidia-* wheels from pypi.nvidia.com.
        Invoke-PipWithRetry -Description "Downloading PyTorch $TorchVersion+$Cuda (~2.5 GB, the slow part)" -PipArgs (
            @('download') + $torchPkgs + @(
                '--dest', $Wheelhouse,
                '--only-binary=:all:',
                '--index-url', "https://download.pytorch.org/whl/$Cuda",
                '--extra-index-url', 'https://pypi.org/simple'
            ) + $PipNetworkArgs)
    }
    Invoke-PipWithRetry -Description 'Downloading Ray / FastAPI / telemetry wheels' -PipArgs (
        @('download') + $reqArgs + $ExtraPins + @(
            '--dest', $Wheelhouse,
            '--only-binary=:all:'
        ) + $PipNetworkArgs)

    # --- 4. Install phase (offline, deterministic) -------------------------------
    $installTargets = @()
    if (-not $SkipTorch) { $installTargets += $torchPkgs }
    $installTargets += $reqArgs + $ExtraPins
    Invoke-PipWithRetry -MaxAttempts 1 -Description 'Installing into python_env from the local wheelhouse (offline)' -PipArgs (
        @('install', '--no-index', '--find-links', $Wheelhouse, '--no-warn-script-location', '--disable-pip-version-check') + $installTargets)

    # --- 5. Verify + manifest ----------------------------------------------------
    Write-TsLog STEP 'Verifying the environment ...'
    & $PythonExe (Join-Path $UsbRoot 'scripts\verify_env.py') --manifest (Join-Path $PythonEnv 'tensorswarm_env.json')
    if ($LASTEXITCODE -ne 0) { throw 'Verification failed (see the table above).' }
    & $PythonExe -m pip freeze --disable-pip-version-check | Set-Content -Encoding ASCII -LiteralPath (Join-Path $PythonEnv 'tensorswarm-freeze.txt')

    if ($PruneWheelhouse) {
        Write-TsLog INFO 'Removing wheelhouse\ (-PruneWheelhouse) ...'
        Remove-Item -LiteralPath $Wheelhouse -Recurse -Force
    }

    $minutes = [Math]::Round(((Get-Date) - $started).TotalMinutes, 1)
    Write-Host ''
    Write-TsLog OK "USB environment ready in $minutes min."
    Write-TsLog OK ("python_env : {0} GB" -f (Get-FolderSizeGB $PythonEnv))
    if (Test-Path -LiteralPath $Wheelhouse) {
        Write-TsLog OK ("wheelhouse : {0} GB (offline repair cache; delete it or re-run with -PruneWheelhouse to reclaim)" -f (Get-FolderSizeGB $Wheelhouse))
    }
    Write-Host ''
    Write-TsLog INFO 'Next: write the installer stick (packs python_env into one file, copies fast):'
    Write-TsLog INFO "  $(Join-Path $UsbRoot 'prepare_usb.cmd')"
    Write-TsLog INFO 'Then at the lab, on each PC: <USB>:\TensorSwarm\install.cmd, and start from the desktop shortcuts.'
}
catch {
    Write-Host ''
    Write-TsLog ERROR $_.Exception.Message
    exit 1
}
