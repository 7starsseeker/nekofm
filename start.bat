@echo off
rem ===========================================================================
rem  NekoFM launcher
rem
rem  This file is intentionally ASCII-only.
rem  Reason: cmd.exe parses .bat bytes using the console codepage (936/GBK on a
rem  Chinese Windows), while the file itself is UTF-8. Non-ASCII text here gets
rem  garbled, and in bad cases cmd tries to execute the mangled bytes as
rem  commands. So: no Chinese in .bat -- all localized text is printed by Node.
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

node "tools\start.js"
if errorlevel 1 pause
