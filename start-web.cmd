@echo off
cd /d "%~dp0"
powershell -NoExit -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-web.ps1"
