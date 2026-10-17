@echo off
setlocal
cd /d "%~dp0"

rem Node 24 o superior es obligatorio y en este PC vive fuera del PATH.
rem Preferir la ruta conocida; si no existe, probar con el node del PATH.
set "NODE_EXE=C:\Users\nicoi\.local\node24\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

if not exist dist\cli.js (
    echo [levantar] Falta dist\cli.js: ejecuta npm ci y npm run build primero.
    pause
    exit /b 1
)

"%NODE_EXE%" -e "process.exit(Number(process.versions.node.split('.')[0])>=24?0:1)" 2>nul
if errorlevel 1 (
    echo [levantar] Node 24 o superior no encontrado en "%NODE_EXE%".
    echo [levantar] Edita este .bat con la ruta correcta o usa deploy\windows\install-autostart.ps1 -NodeExe "C:\ruta\node.exe".
    pause
    exit /b 1
)

"%NODE_EXE%" dist\cli.js serve
if errorlevel 1 (
    echo [levantar] El servicio termino con error.
    pause
    exit /b 1
)
endlocal
