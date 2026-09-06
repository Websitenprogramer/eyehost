@echo off
cd /d "%~dp0"
title Eye Host Panel
echo Starte Eye Host auf http://localhost:3000
node server.js
pause
