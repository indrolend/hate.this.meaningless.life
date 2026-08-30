@echo off
setlocal
title CommandHUD Shell
rem Compatibility alias. Prefer CommandHUD-TUI.cmd or CommandHUD.cmd shell.
call "%~dp0CommandHUD.cmd" shell %*
exit /b %ERRORLEVEL%
