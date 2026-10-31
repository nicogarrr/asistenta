@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul
rem Abierto desde dentro del ZIP: Windows solo copia este .bat a una carpeta temporal.
if not exist package.json (
    echo [instalar] No encuentro los archivos de Asistenta junto a este .bat.
    echo [instalar] Si lo has abierto desde el ZIP, descomprimelo primero ^(clic derecho, "Extraer todo"^) y abre instalar.bat desde esa carpeta.
    pause
    exit /b 1
)
rem Instalacion de Asistenta en un paso: comprueba Node, instala, compila y
rem pide solo el token de Telegram y la clave del modelo (y confirma tu ID).
rem Node 24 o mas nuevo: lo busca scripts\node24.cmd (PATH y carpetas habituales).
call scripts\node24.cmd
if not defined NODE_EXE (
    echo [instalar] No encuentro Node 24 o mas nuevo. Descargalo gratis de https://nodejs.org ^(version 24 LTS^), instalalo y vuelve a abrir este archivo.
    echo [instalar] Si ya lo tienes en otra carpeta, pon su ruta en la variable ASISTENTA_NODE, por ejemplo C:\node24\node.exe.
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
