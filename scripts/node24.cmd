@echo off
rem Busca Node 24 o mas nuevo y deja su ruta en NODE_EXE (vacia si no hay).
rem Lo usan instalar.bat y levantar.bat. Orden: la variable ASISTENTA_NODE
rem (si la pones a mano), el node del PATH y las carpetas de instalacion
rem habituales (instalador oficial, nvm-windows, scoop, una copia portable).
rem Si Node esta fuera del PATH, mete su carpeta en el PATH para que npm
rem (que va al lado de node.exe) tambien se encuentre.
set "NODE_EXE="
for %%N in ("%ASISTENTA_NODE%" "node" "%ProgramFiles%\nodejs\node.exe" "%LOCALAPPDATA%\Programs\nodejs\node.exe" "%NVM_SYMLINK%\node.exe" "%USERPROFILE%\scoop\apps\nodejs\current\node.exe" "%USERPROFILE%\.local\node24\node.exe") do (
    if not defined NODE_EXE call :probar %%N
)
exit /b 0

:probar
if "%~1"=="" exit /b 0
"%~1" -e "process.exit(Number(process.versions.node.split('.')[0])>=24?0:1)" >nul 2>nul
if errorlevel 1 exit /b 0
set "NODE_EXE=%~1"
if /i not "%~1"=="node" set "PATH=%~dp1;%PATH%"
exit /b 0
