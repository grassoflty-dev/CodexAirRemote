@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
".venv\Scripts\python.exe" -u "host\flash.py" %*
set "AIRREMOTE_RESULT=%ERRORLEVEL%"
echo.
if not "%AIRREMOTE_RESULT%"=="0" echo Flash or setup did not finish. See the message above.
pause
exit /b %AIRREMOTE_RESULT%
