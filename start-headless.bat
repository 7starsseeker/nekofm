@echo off
rem ===========================================================================
rem  NekoFM headless launcher (no Electron)
rem  ASCII-only on purpose -- see start.bat for the reason.
rem  Usage: start-headless.bat [--room <roomId>] [--order "<keyword>"]
rem ===========================================================================
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 22 or newer.
  echo         https://nodejs.org/
  pause
  exit /b 1
)

node "tools\headless.js" %*
pause
