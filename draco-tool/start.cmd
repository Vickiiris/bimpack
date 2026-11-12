@echo off
setlocal
chcp 65001 >nul
title Draco Compressor

rem Pure ASCII on purpose: cmd.exe reads .cmd files in the OEM codepage (936 on zh-CN),
rem so any UTF-8 Chinese in here can be mis-parsed as command separators.
rem All Chinese messages are printed by Node instead.

pushd "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

rem Draco encoding a 200MB floor pushes the heap past 2GB
set NODE_OPTIONS=--max-old-space-size=8192

node "%~dp0server.mjs"
set CODE=%errorlevel%
if not "%CODE%"=="0" (
  echo.
  echo   Exited with code %CODE%. Press any key to close this window.
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
