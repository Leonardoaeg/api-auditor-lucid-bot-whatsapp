@echo off
cd /d "%~dp0"
:loop
echo [%date% %time%] Iniciando dashboard-server.js >> keep-alive.log
node dashboard-server.js >> keep-alive.log 2>&1
echo [%date% %time%] Se detuvo (codigo %errorlevel%), reiniciando en 3s... >> keep-alive.log
timeout /t 3 /nobreak > nul
goto loop
