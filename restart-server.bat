@echo off
echo Stopping existing server on port 8080...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8080 " ^| findstr "LISTENING"') do (
    echo Killing PID %%a
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 1 /nobreak >nul
echo Starting School Scanner...
powershell -ExecutionPolicy Bypass -File "%~dp0start-server.ps1"
