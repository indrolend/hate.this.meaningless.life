@echo off
setlocal
node "%~dp0packages\commandhud\cli.mjs" %*
exit /b %ERRORLEVEL%
