@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "POWERSHELL_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%POWERSHELL_EXE%" (
  echo Windows PowerShell is unavailable on this computer.
  pause
  exit /b 1
)
"%POWERSHELL_EXE%" -NoProfile -STA -ExecutionPolicy Bypass -File "admin\scripts\copy-admin-password.ps1"
if errorlevel 1 (
  echo.
  echo Copying the RuoYi administrator password failed. Read the PowerShell error above.
  pause
)
