@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title Draco Compressor - stop

rem The server binds 8099 and walks up if the port is busy, so scan a small range.
set FOUND=0
for %%P in (8099 8100 8101 8102 8103 8104 8105 8106 8107 8108 8109 8110 8111) do (
  for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%%P .*LISTENING"') do (
    echo   stopping PID %%p on port %%P
    taskkill /PID %%p /T /F >nul 2>nul
    set FOUND=1
  )
)
if "%FOUND%"=="0" echo   no listener found - nothing to stop.
echo   done.
timeout /t 2 >nul
exit /b 0
