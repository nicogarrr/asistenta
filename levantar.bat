@echo off
setlocal
rem Desde una carpeta de red (\\servidor\...) cmd no puede entrar en ella y
rem acabaria en C:\Windows diciendo que falta todo: mejor avisarlo claro.
if "%~d0"=="\\" (
    echo [levantar] Asistenta esta en una carpeta de red. Copiala a tu PC, por ejemplo a C:\Asistenta, y abre levantar.bat desde alli.
    pause
    exit /b 1
)
cd /d "%~dp0"
rem UTF-8 para que la lista de pa iniciar (tildes y simbolos) se lea bien en la consola.
chcp 65001 >nul
rem Abierto desde dentro del ZIP: Windows solo copia este .bat a una carpeta temporal.
if not exist package.json (
    echo [levantar] No encuentro los archivos de Asistenta junto a este .bat.
    echo [levantar] Si lo has abierto desde el ZIP, descomprimelo primero ^(clic derecho, "Extraer todo"^) y abre levantar.bat desde esa carpeta.
    pause
    exit /b 1
)

if not exist dist\cli.js (
    echo [levantar] Asistenta aun no esta instalada: haz doble clic en instalar.bat primero.
    pause
    exit /b 1
)

rem npm escribe node_modules\.package-lock.json al terminar: sin el, la instalacion
rem quedo a medias (npm ci fallido o node_modules borrada) y Node soltaria un error en ingles.
if not exist node_modules\.package-lock.json (
    echo [levantar] La instalacion de Asistenta esta incompleta ^(faltan piezas en node_modules^).
    echo [levantar] Haz doble clic en instalar.bat para completarla y vuelve a abrir este archivo.
    pause
    exit /b 1
)

rem Node 24 o mas nuevo: lo busca scripts\node24.cmd (PATH y carpetas habituales).
call scripts\node24.cmd
if not defined NODE_EXE (
    if defined NODE_OLD (
        echo [levantar] Tienes Node %NODE_OLD%, pero Asistenta necesita la version 24 o mas nueva.
        echo [levantar] Descarga la 24 LTS gratis de https://nodejs.org, instalala encima de la que tienes y vuelve a abrir este archivo.
        pause
        exit /b 1
    )
    echo [levantar] No encuentro Node 24 o mas nuevo. Descargalo gratis de https://nodejs.org ^(version 24 LTS^), instalalo y vuelve a abrir este archivo.
    echo [levantar] Si ya lo tienes en otra carpeta, pon su ruta en la variable ASISTENTA_NODE, por ejemplo C:\node24\node.exe.
    pause
    exit /b 1
)

rem pa iniciar comprueba todo (verde/rojo, con el arreglo al lado) y, si nada lo
rem impide, arranca igual que pa serve. Si algo falla, la lista queda en pantalla.
"%NODE_EXE%" dist\cli.js iniciar
if errorlevel 1 (
    echo [levantar] No ha arrancado o termino con error: revisa la lista de arriba.
    pause
    exit /b 1
)
endlocal
