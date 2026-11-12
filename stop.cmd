@echo off
setlocal
chcp 65001 >nul
title BIM Pack - stop

pushd "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

node "%~dp0stop.mjs" --scan
echo.
pause >nul
popd
exit /b 0

:nonode
echo.
echo   Node.js not found. Open Task Manager and end any node.exe process manually.
echo.
pause
exit /b 1
