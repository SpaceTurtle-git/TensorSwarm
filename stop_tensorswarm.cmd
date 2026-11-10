@echo off
rem Stop all TensorSwarm processes launched from this USB
rem Wrapper so the script runs even where the PowerShell ExecutionPolicy blocks .ps1 files.
rem Arguments are passed through, e.g.:  stop_tensorswarm.cmd -WhatIf
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop_tensorswarm.ps1" %*
set "TS_EXIT=%ERRORLEVEL%"
if not "%TS_EXIT%"=="0" (
    echo.
    echo [TensorSwarm] Exited with code %TS_EXIT%. Press any key to close.
    pause >nul
)
exit /b %TS_EXIT%
