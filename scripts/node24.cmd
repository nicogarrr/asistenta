@echo off
rem Busca Node 24 o mas nuevo y deja su ruta en NODE_EXE (vacia si no hay).
rem Lo usan instalar.bat y levantar.bat. Orden: la variable ASISTENTA_NODE
rem (si la pones a mano), el node del PATH y las carpetas de instalacion
rem habituales (instalador oficial, nvm-windows, scoop, una copia portable).
rem Si Node esta fuera del PATH, mete su carpeta en el PATH para que npm
rem (que va al lado de node.exe) tambien se encuentre.
set "NODE_EXE="
rem NODE_OLD: version del primer Node demasiado viejo que encuentra (para decirlo claro).
set "NODE_OLD="
rem ASISTENTA_NODE_FUERA_PATH: el Node elegido no esta en el PATH (los avisos dan su ruta completa).
set "ASISTENTA_NODE_FUERA_PATH="
for %%N in ("%ASISTENTA_NODE%" "node" "%ProgramFiles%\nodejs\node.exe" "%LOCALAPPDATA%\Programs\nodejs\node.exe" "%NVM_SYMLINK%\node.exe" "%USERPROFILE%\scoop\apps\nodejs\current\node.exe" "%USERPROFILE%\.local\node24\node.exe") do (
    if not defined NODE_EXE call :probar %%N
)
exit /b 0

:probar
if "%~1"=="" exit /b 0
"%~1" -e "process.exit(Number(process.versions.node.split('.')[0])>=24?0:1)" >nul 2>nul
if errorlevel 1 goto :viejo
set "NODE_EXE=%~1"
if /i not "%~1"=="node" set "PATH=%~dp1;%PATH%"
if /i not "%~1"=="node" set "ASISTENTA_NODE_FUERA_PATH=1"
exit /b 0

:viejo
if defined NODE_OLD exit /b 0
"%~1" -v >"%TEMP%\asistenta-node-v.txt" 2>nul
set /p NODE_OLD=<"%TEMP%\asistenta-node-v.txt"
del "%TEMP%\asistenta-node-v.txt" >nul 2>nul
exit /b 0
