@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "POWERSHELL_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%POWERSHELL_EXE%" (
  echo Windows PowerShell is unavailable on this computer.
  pause
  exit /b 1
)
"%POWERSHELL_EXE%" -NoProfile -ExecutionPolicy Bypass -File "admin\scripts\start-user-portal.ps1"
if errorlevel 1 (
  echo.
  echo User portal startup failed. Read the PowerShell error above and .local-web\ruoyi\logs.
  pause
  exit /b 1
)
echo.
echo User portal opened in your browser.
ping.exe 127.0.0.1 -n 4 >nul 2>nul
exit /b 0
