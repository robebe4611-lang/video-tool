@echo off
cd /d "%~dp0"
git pull
call npm install
echo.
echo Updated. Close the server window and run start.bat again.
pause
