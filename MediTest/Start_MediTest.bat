@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

set "PORT=55000"
set "ASPNETCORE_URLS=http://127.0.0.1:%PORT%"
set "DOTNET_URLS=http://127.0.0.1:%PORT%"

dotnet run --configuration Release --no-launch-profile
exit /b %ERRORLEVEL%
