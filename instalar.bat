@echo off
setlocal
rem Desde una carpeta de red (\\servidor\...) cmd no puede entrar en ella y
rem acabaria en C:\Windows diciendo que falta todo: mejor avisarlo claro.
if "%~d0"=="\\" (
    echo [instalar] Asistenta esta en una carpeta de red. Copiala a tu PC, por ejemplo a C:\Asistenta, y abre instalar.bat desde alli.
    pause
    exit /b 1
)
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
    if defined NODE_OLD (
        echo [instalar] Tienes Node %NODE_OLD%, pero Asistenta necesita la version 24 o mas nueva.
        echo [instalar] Descarga la 24 LTS gratis de https://nodejs.org, instalala encima de la que tienes y vuelve a abrir este archivo.
        pause
        exit /b 1
    )
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
