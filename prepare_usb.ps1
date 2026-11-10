<#
.SYNOPSIS
    Writes a TensorSwarm INSTALLER stick from the environment built at home (fast: one big file).

.DESCRIPTION
    Copying python_env\ itself means ~31,000 small files, which takes 10+ minutes on a USB stick.
    This script instead:
      1. Packs python_env\ into ONE archive, dist\python_env.tar.gz (~2-3 GB). This happens
         only when the environment changed; the archive is cached between runs.
      2. Copies the code (a few MB) plus that archive to <USB>\TensorSwarm\.
    At the lab, run <USB>\TensorSwarm\install.cmd on each PC. It unpacks to C:\TensorSwarm in a
    few minutes, then the stick moves on to the next PC.

.EXAMPLE
    .\prepare_usb.cmd               # auto-detects the USB stick (asks if there are several)
.EXAMPLE
    .\prepare_usb.cmd -Drive F
.EXAMPLE
    .\prepare_usb.cmd -CodeOnly     # code changed only: refresh the stick in seconds
.EXAMPLE
    .\prepare_usb.cmd -CodeOnly -Datasets cifar10,iris   # also put these datasets on the stick
    .\prepare_usb.cmd -Datasets *                        # every dataset in this PC's store
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    # USB drive letter (E, E:, or E:\). Omitted = auto-detect removable drives.
    [string]$Drive,
    # Full target folder instead of <Drive>:\TensorSwarm.
    [string]$Destination,
    # Only refresh the code on the stick; leave the archive there as it is.
    [switch]$CodeOnly,
    # Re-pack the archive even if the environment looks unchanged.
    [switch]$Repack,
    # Datasets from this PC's store (C:\ProgramData\TensorSwarm\datasets\store) to put on the
    # stick; install.cmd then seeds them on every PC, so big datasets never cross the network.
    # Names or ids, or * for all. Only changed files are copied.
    [string[]]$Datasets
)

$ErrorActionPreference = 'Stop'
$Root      = $PSScriptRoot
$PythonEnv = Join-Path $Root 'python_env'
$PythonExe = Join-Path $PythonEnv 'python.exe'
$DistDir   = Join-Path $Root 'dist'
$Archive   = Join-Path $DistDir 'python_env.tar.gz'
$BuildFile = Join-Path $DistDir 'python_env.build.txt'
$CountFile = Join-Path $DistDir 'python_env.files.txt'
Import-Module (Join-Path $Root 'scripts\TensorSwarm.Common.psm1') -Force -DisableNameChecking

Write-TsBanner 'TensorSwarm - Prepare installer USB (run at home)'
$started = Get-Date

try {
    # --------------------------------------------------------------------------
    # 1. Target folder on the stick.
    # --------------------------------------------------------------------------
    if (-not $Destination) {
        if (-not $Drive) {
            $removable = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=2' | Where-Object { $_.Size -gt 0 })
            if ($removable.Count -eq 1) {
                $Drive = $removable[0].DeviceID
                Write-TsLog INFO ("Detected USB drive {0} ({1}, {2:N1} GB free)" -f $Drive, $removable[0].VolumeName, ($removable[0].FreeSpace / 1GB))
            }
            else {
                if ($removable.Count -gt 1) { Write-TsLog INFO ("Removable drives: " + (($removable | ForEach-Object { $_.DeviceID }) -join ', ')) }
                $Drive = (Read-Host 'USB drive letter (e.g. E)').Trim()
            }
        }
        $letter = ($Drive.Trim() -replace '[:\\/]', '')
        if ($letter -notmatch '^[A-Za-z]$') { throw "'$Drive' is not a drive letter." }
        if (-not (Test-Path -LiteralPath "${letter}:\")) { throw "Drive ${letter}: is not connected." }
        $Destination = "${letter}:\TensorSwarm"
    }
    $Destination = [System.IO.Path]::GetFullPath($Destination)
    if ($Destination.TrimEnd('\') -ieq $Root.TrimEnd('\')) {
        throw 'The destination is this folder itself. Run prepare_usb from the home copy of the project, not from the stick.'
    }
    Write-TsLog INFO "Source      : $Root"
    Write-TsLog INFO "Destination : $Destination"

    # --------------------------------------------------------------------------
    # 2. Pack the environment (cached).
    # --------------------------------------------------------------------------
    if (-not $CodeOnly) {
        Assert-TsPython -PythonExe $PythonExe
        Initialize-TsPythonEnvironment -PythonEnv $PythonEnv

        # Catch broken environments at home, not at the lab: Ray's CLI must actually start.
        $cli = Invoke-TsNative -FilePath $PythonExe -Arguments @('-m', 'ray.scripts.scripts', 'start', '--help')
        if ($cli.ExitCode -ne 0) {
            throw ("'ray start' is broken in python_env (often click>=8.3). Fix it with:`n" +
                   "        python_env\python.exe -m pip install `"click<8.3`"")
        }
        $verify = Invoke-TsNative -FilePath $PythonExe -Arguments @((Join-Path $Root 'scripts\verify_env.py'))
        if ($verify.ExitCode -ne 0) { $verify.Output | Write-Host; throw 'python_env failed verification (see above).' }
        Write-TsLog OK 'python_env verified (imports + ray CLI).'

        # Build id = hash of the exact package set + Python version. The installer compares it to
        # the installed copy and skips the unpack when nothing changed.
        $freeze = Invoke-TsNative -FilePath $PythonExe -Arguments @('-m', 'pip', 'freeze', '--disable-pip-version-check')
        $pyVer  = (Invoke-TsNative -FilePath $PythonExe -Arguments @('-c', 'import sys; print(sys.version)')).Output -join ''
        $freezeText = ($freeze.Output -join "`n")
        [System.IO.File]::WriteAllText((Join-Path $PythonEnv 'tensorswarm-freeze.txt'), $freezeText + "`n")
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes("$pyVer`n$freezeText"))
        $buildId = (-join ($hash[0..7] | ForEach-Object { $_.ToString('x2') }))
        [System.IO.File]::WriteAllText((Join-Path $PythonEnv 'tensorswarm_build_id.txt'), $buildId)
        Write-TsLog INFO "Environment build id: $buildId"

        $cachedId = $null
        if (Test-Path -LiteralPath $BuildFile) { $cachedId = (Get-Content -LiteralPath $BuildFile -Raw).Trim() }
        if (-not $Repack -and $cachedId -eq $buildId -and (Test-Path -LiteralPath $Archive) -and (Test-Path -LiteralPath $CountFile)) {
            Write-TsLog OK ("Archive is up to date: {0} ({1:N2} GB)" -f $Archive, ((Get-Item -LiteralPath $Archive).Length / 1GB))
        }
        else {
            if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) { throw 'tar.exe not found (needs Windows 10 1803 or newer).' }
            $null = New-Item -ItemType Directory -Force -Path $DistDir
            $partial = "$Archive.partial"
            Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $BuildFile, $CountFile -Force -ErrorAction SilentlyContinue
            $expected = @(Get-ChildItem -LiteralPath $PythonEnv -Recurse -File -Force).Count
            Write-TsLog STEP "Packing python_env ($expected files) into one archive (once per environment change, ~10 min, no output) ..."
            $t = Get-Date
            & tar.exe -czf $partial -C $Root python_env
            if ($LASTEXITCODE -ne 0) { Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue; throw "tar failed with exit code $LASTEXITCODE. Close anything using python_env and retry." }

            # Never ship an incomplete archive: count what actually went in.
            Write-TsLog STEP 'Checking the archive ...'
            $entries = @(& tar.exe -tzf $partial | Where-Object { $_ -notlike '*/' }).Count
            if ($LASTEXITCODE -ne 0 -or $entries -ne $expected) {
                Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
                throw "The archive holds $entries files but python_env has $expected. Close anything using python_env and retry."
            }
            Move-Item -LiteralPath $partial -Destination $Archive -Force
            [System.IO.File]::WriteAllText($CountFile, "$expected")
            [System.IO.File]::WriteAllText($BuildFile, $buildId)
            Write-TsLog OK ("Packed in {0:N0} s: {1:N2} GB" -f ((Get-Date) - $t).TotalSeconds, ((Get-Item -LiteralPath $Archive).Length / 1GB))
        }
    }

    # --------------------------------------------------------------------------
    # 3. Space / filesystem checks on the stick.
    # --------------------------------------------------------------------------
    $qualifier = Split-Path -Qualifier $Destination
    $vol = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$qualifier'" -ErrorAction SilentlyContinue
    if ($vol -and -not $CodeOnly) {
        $archiveBytes = (Get-Item -LiteralPath $Archive).Length
        $existing = Join-Path $Destination 'payload\python_env.tar.gz'
        $reclaim = 0; if (Test-Path -LiteralPath $existing) { $reclaim = (Get-Item -LiteralPath $existing).Length }
        if ($vol.FileSystem -eq 'FAT32' -and $archiveBytes -ge 4GB) {
            throw 'The stick is FAT32, which cannot hold files over 4 GB. Reformat it as exFAT or NTFS.'
        }
        if (($vol.FreeSpace + $reclaim) -lt ($archiveBytes + 200MB)) {
            throw ("Not enough space on {0}: need {1:N1} GB, have {2:N1} GB." -f $qualifier, (($archiveBytes + 200MB) / 1GB), (($vol.FreeSpace + $reclaim) / 1GB))
        }
    }

    # --------------------------------------------------------------------------
    # 4. Code (few MB). /MIR removes stale code files but never touches the excluded
    #    folders on the stick (payload, an old python_env, logs) or per-PC .env files.
    # --------------------------------------------------------------------------
    # The dashboard ships pre-built (master\dashboard) so lab PCs need no Node.js: the Master
    # serves it on port 8000. Rebuild it here when the frontend source is newer than the build.
    $frontendDir  = Join-Path $Root 'frontend'
    $dashStamp    = Join-Path $Root 'master\dashboard\BUILD_INFO.txt'
    $stampTime    = if (Test-Path -LiteralPath $dashStamp) { (Get-Item -LiteralPath $dashStamp).LastWriteTimeUtc } else { [datetime]::MinValue }
    $newestSource = Get-ChildItem -LiteralPath $frontendDir -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch '\\(node_modules|\.next|out)\\' -and $_.Extension -in '.ts', '.tsx', '.css', '.js', '.json', '.svg' } |
        Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if ($newestSource -and $newestSource.LastWriteTimeUtc -gt $stampTime) {
        $node = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($node -and (Test-Path -LiteralPath (Join-Path $frontendDir 'node_modules\next'))) {
            Write-TsLog STEP 'Frontend changed: rebuilding the dashboard (npm run build:static, ~1 min) ...'
            & $node.Source (Join-Path $frontendDir 'build-static.js')
            if ($LASTEXITCODE -ne 0) { throw 'Dashboard build failed (see the output above).' }
            Write-TsLog OK 'Dashboard rebuilt into master\dashboard.'
        }
        elseif ($stampTime -eq [datetime]::MinValue) {
            Write-TsLog WARN 'The dashboard is not built (master\dashboard missing) and Node.js/node_modules are not available here.'
            Write-TsLog WARN 'The Master will still run, but http://<MASTER_IP>:8000 will show no dashboard. Fix: cd frontend; npm install; npm run build:static'
        }
        else {
            Write-TsLog WARN 'Frontend source is newer than master\dashboard, but Node.js is not available to rebuild it. Shipping the existing build.'
        }
    }

    Write-TsLog STEP 'Copying code ...'
    $null = New-Item -ItemType Directory -Force -Path $Destination
    $exclDirs = Get-TsCodeCopyExclusions -Source $Root -Destination $Destination
    & robocopy.exe $Root $Destination /MIR /XD @exclDirs /XF .env '*.pyc' '*.partial' /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed copying the code (exit $LASTEXITCODE)." }
    Write-TsLog OK 'Code copied.'

    # --------------------------------------------------------------------------
    # 5. The archive: one big sequential file (unbuffered I/O, restartable).
    # --------------------------------------------------------------------------
    if (-not $CodeOnly) {
        $payload = Join-Path $Destination 'payload'
        $usbId = $null
        if (Test-Path -LiteralPath (Join-Path $payload 'python_env.build.txt')) { $usbId = (Get-Content -LiteralPath (Join-Path $payload 'python_env.build.txt') -Raw).Trim() }
        $usbArchive = Join-Path $payload 'python_env.tar.gz'
        if ($usbId -eq $buildId -and (Test-Path -LiteralPath $usbArchive) -and (Get-Item -LiteralPath $usbArchive).Length -eq (Get-Item -LiteralPath $Archive).Length) {
            Write-TsLog OK 'The stick already has this archive.'
        }
        else {
            Write-TsLog STEP ("Copying the archive to the stick ({0:N2} GB) ..." -f ((Get-Item -LiteralPath $Archive).Length / 1GB))
            $t = Get-Date
            Remove-Item -LiteralPath (Join-Path $payload 'python_env.build.txt') -Force -ErrorAction SilentlyContinue
            & robocopy.exe $DistDir $payload 'python_env.tar.gz' 'python_env.files.txt' /J /R:3 /W:2 /NJH /NJS /NDL
            if ($LASTEXITCODE -ge 8) { throw "robocopy failed copying the archive (exit $LASTEXITCODE)." }
            # Written last: an interrupted copy is never mistaken for a complete one.
            Copy-Item -LiteralPath $BuildFile -Destination (Join-Path $payload 'python_env.build.txt') -Force
            $secs = [Math]::Max(1, ((Get-Date) - $t).TotalSeconds)
            Write-TsLog OK ("Archive copied in {0:N0} s ({1:N0} MB/s)." -f $secs, ((Get-Item -LiteralPath $Archive).Length / 1MB / $secs))
        }
    }

    # --------------------------------------------------------------------------
    # 6. Optional datasets (seeded into each PC's store by install.cmd).
    # --------------------------------------------------------------------------
    # Through prepare_usb.cmd (powershell -File) "a,b" arrives as ONE string: split it.
    $Datasets = @($Datasets | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($Datasets.Count -gt 0) {
        Write-TsLog STEP "Copying datasets to the stick: $($Datasets -join ', ') ..."
        $dsArgs = @((Join-Path $Root 'scripts	s_dataset.py'), 'export', '--to', (Join-Path $Destination 'datasets'))
        if ($vol -and $vol.FileSystem -eq 'FAT32') { $dsArgs += @('--max-file-bytes', '4294967295') }
        if (-not ($Datasets.Count -eq 1 -and $Datasets[0] -eq '*')) { $dsArgs += $Datasets }
        & $PythonExe @dsArgs
        if ($LASTEXITCODE -ne 0) { throw "Copying datasets failed (exit $LASTEXITCODE). See the message above." }
        Write-TsLog OK 'Datasets copied; install.cmd will seed them on every PC.'
    }

    $oldEnv = Join-Path $Destination 'python_env'
    $oldWheel = Join-Path $Destination 'wheelhouse'
    $stale = @($oldEnv, $oldWheel) | Where-Object { Test-Path -LiteralPath $_ }
    $minutes = [Math]::Round(((Get-Date) - $started).TotalMinutes, 1)
    Write-Host ''
    Write-Host ('=' * 70) -ForegroundColor Green
    Write-TsLog OK "Installer USB ready in $minutes min: $Destination"
    Write-Host ('=' * 70) -ForegroundColor Green
    Write-TsLog INFO 'At the lab, on EACH PC (Master PC first):'
    Write-TsLog INFO "  1. Install Tailscale and sign in."
    Write-TsLog INFO "  2. Double-click $qualifier\TensorSwarm\install.cmd  (click Yes on the admin prompt if you can)"
    Write-TsLog INFO '  3. Unplug the stick and take it to the next PC. Then start from the desktop shortcuts.'
    if ($stale) {
        Write-Host ''
        Write-TsLog INFO 'Not needed on the stick any more (safe to delete, frees space; the installer ignores them):'
        foreach ($p in $stale) { Write-TsLog INFO "  $p" }
    }
}
catch {
    Write-Host ''
    Write-TsLog ERROR $_.Exception.Message
    exit 1
}
exit 0
