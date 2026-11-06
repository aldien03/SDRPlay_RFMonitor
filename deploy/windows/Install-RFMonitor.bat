@echo off
rem RF Monitor Windows installer launcher. Double-click this file.
rem It asks Windows for administrator rights, then runs install-rfmonitor.ps1.
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Asking Windows for administrator permission...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-rfmonitor.ps1" %*
echo.
pause
