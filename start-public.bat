@echo off
cd /d "%~dp0"
start "Eye Host" cmd /c node server.js
timeout /t 2 /nobreak >nul
ngrok http 3000
