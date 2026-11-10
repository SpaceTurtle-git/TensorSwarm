@echo off
rem TensorSwarm Worker (Windows native, from USB)
rem Wrapper so the script runs even where the PowerShell ExecutionPolicy blocks .ps1 files.
rem Arguments are passed through, e.g.:  start_worker.cmd 100.80.10.1
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_worker.ps1" %*
set "TS_EXIT=%ERRORLEVEL%"
if not "%TS_EXIT%"=="0" (
    echo.
    echo [TensorSwarm] Exited with code %TS_EXIT%. Press any key to close.
    pause >nul
)
exit /b %TS_EXIT%
