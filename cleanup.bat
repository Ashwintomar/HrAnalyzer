@echo off
echo Killing any remaining Node.js processes...

:: Kill all node.exe processes
taskkill /F /IM node.exe /T 2>nul
if %errorlevel%==0 (
    echo ✅ Node.js processes terminated
) else (
    echo ℹ️ No Node.js processes found running
)

:: Kill any processes on port 3000
for /f "tokens=5" %%a in ('netstat -aon ^| find ":3000" ^| find "LISTENING"') do (
    echo Killing process %%a on port 3000...
    taskkill /F /PID %%a 2>nul
)

echo.
echo ✅ Cleanup completed!
echo You can now safely restart the Hr Analyzer application.
pause
