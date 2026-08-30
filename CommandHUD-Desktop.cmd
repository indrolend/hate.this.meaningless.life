@echo off
setlocal
where node.exe >nul 2>nul || (
  echo CommandHUD needs Node.js. Install Node.js and reopen this launcher.
  exit /b 1
)
node "%~dp0packages\commandhud\cli.mjs" desktop %*
exit /b %ERRORLEVEL%
