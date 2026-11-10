@echo off
rem Install TensorSwarm from this USB stick to C:\TensorSwarm (run on each lab PC).
rem Wrapper so the script runs even where the PowerShell ExecutionPolicy blocks .ps1 files.
rem Arguments are passed through, e.g.:  install.cmd -Destination D:\TensorSwarm
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "TS_EXIT=%ERRORLEVEL%"
echo.
if "%TS_EXIT%"=="0" (echo [TensorSwarm] Done. Press any key to close.) else (echo [TensorSwarm] Exited with code %TS_EXIT%. Press any key to close.)
pause >nul
exit /b %TS_EXIT%
