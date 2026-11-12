@echo off
setlocal
chcp 65001 >nul
title BIM Pack

rem Pure ASCII on purpose: cmd.exe reads this file in the OEM codepage (936 on zh-CN),
rem so any UTF-8 Chinese in here can be mis-parsed as command separators. All Chinese
rem messages are printed by Node instead.

pushd "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

node "%~dp0start.mjs"
if errorlevel 1 (
  echo.
  echo   Startup failed. Press any key to close this window.
  pause >nul
)
popd
exit /b 0

:nonode
echo.
echo   Node.js not found.
echo   Install Node 18 or newer from https://nodejs.org/ and run this file again.
echo.
pause
exit /b 1
