@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul
rem Instalacion de Asistenta en un paso: comprueba Node, instala, compila y
rem pide solo el token de Telegram y la clave del modelo (y confirma tu ID).
rem Misma eleccion de Node que levantar.bat: la ruta conocida o el del PATH.
set "NODE_EXE=C:\Users\nicoi\.local\node24\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
"%NODE_EXE%" -v >nul 2>nul
if errorlevel 1 (
    echo [instalar] No encuentro Node. Descargalo gratis de https://nodejs.org ^(version 24 o mas nueva^), instalalo y vuelve a abrir este archivo.
    pause
    exit /b 1
)
"%NODE_EXE%" scripts\instalar.mjs
if errorlevel 1 (
    echo [instalar] No ha terminado: lee el mensaje de arriba.
    pause
    exit /b 1
)
pause
endlocal
