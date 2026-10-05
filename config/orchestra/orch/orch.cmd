@echo off
setlocal
set "ALETHE_ORCHESTRA_CLI=wrapper"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0orch.ps1" %*
exit /b %ERRORLEVEL%
