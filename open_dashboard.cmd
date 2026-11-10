@echo off
rem Open the TensorSwarm dashboard (served by the Master on port 8000) in the browser
rem Wrapper so the script runs even where the PowerShell ExecutionPolicy blocks .ps1 files.
rem Arguments are passed through, e.g.:  open_dashboard.cmd 100.101.102.103
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0open_dashboard.ps1" %*
set "TS_EXIT=%ERRORLEVEL%"
if not "%TS_EXIT%"=="0" (
    echo.
    echo [TensorSwarm] Exited with code %TS_EXIT%. Press any key to close.
    pause >nul
)
exit /b %TS_EXIT%
