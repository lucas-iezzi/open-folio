@echo off
title open-folio Launcher
cd /d "%~dp0"

where node >nul 2>&1
if %errorlevel% equ 0 goto :deps

echo.
echo   Node.js is not installed.
echo.

where winget >nul 2>&1
if %errorlevel% neq 0 goto :manual

echo   Installing Node.js LTS via winget (this may take a minute)...
echo.
winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
if %errorlevel% neq 0 goto :manual

echo.
echo   Node.js installed! Close this window and double-click Start.bat again.
echo.
pause
exit /b 0

:manual
echo   Automatic install failed.
echo   Download Node.js from: https://nodejs.org
echo   Install it, then double-click Start.bat again.
echo.
start "" "https://nodejs.org/en/download"
pause
exit /b 1

:deps
if exist "%~dp0node_modules\express" goto :launch
echo.
echo   Installing dependencies (first run only — takes about 30 seconds)...
echo.
call npm install --no-fund --no-audit
if %errorlevel% neq 0 (
    echo.
    echo   npm install failed. Check the output above.
    pause
    exit /b 1
)

:launch
node "%~dp0scripts\launcher-server.js"
if %errorlevel% gtr 1 (
    echo.
    echo   Launcher exited with an error. See above for details.
    pause
)
