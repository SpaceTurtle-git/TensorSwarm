@echo off
rem Build the portable Python env on the USB (run once, at home)
rem Wrapper so the script runs even where the PowerShell ExecutionPolicy blocks .ps1 files.
rem Arguments are passed through, e.g.:  build_usb_env.cmd -Cuda cu118
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build_usb_env.ps1" %*
set "TS_EXIT=%ERRORLEVEL%"
if not "%TS_EXIT%"=="0" (
    echo.
    echo [TensorSwarm] Exited with code %TS_EXIT%. Press any key to close.
    pause >nul
)
exit /b %TS_EXIT%
