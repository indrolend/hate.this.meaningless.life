@echo off
setlocal
title CommandHUD Shell
where node.exe >nul 2>nul || (
  echo CommandHUD needs Node.js. Install Node.js and reopen this launcher.
  exit /b 1
)
node "%~dp0packages\commandhud\cli.mjs" shell --root "%CD%"
exit /b %ERRORLEVEL%
