@echo off
rem TensorSwarm Master (Windows native, from USB)
rem Wrapper so the script runs even where the PowerShell ExecutionPolicy blocks .ps1 files.
rem Arguments are passed through, e.g.:  start_master.cmd -OrchestratorOnly
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_master.ps1" %*
set "TS_EXIT=%ERRORLEVEL%"
if not "%TS_EXIT%"=="0" (
    echo.
    echo [TensorSwarm] Exited with code %TS_EXIT%. Press any key to close.
    pause >nul
)
exit /b %TS_EXIT%
