@echo off
cd /d "%~dp0"
echo Stopping any process on port 8787...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8787 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
timeout /t 2 /nobreak >nul
echo Starting Dyna Store + Bakong proxy...
echo Open: http://127.0.0.1:8787/index.html
node server.mjs
