@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js isn't installed. Get the LTS version from https://nodejs.org and run this again. & pause & exit /b)
if not exist node_modules (echo First run: installing... & call npm install --omit=dev)
if not exist .env (copy .env.example .env >nul & echo Made a .env file: open it in Notepad, fill it in, then run this again. & notepad .env & exit /b)
start "" http://localhost:3090
node src\main.js
pause
