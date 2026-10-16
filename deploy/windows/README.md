# Arranque oculto al iniciar sesión en Windows

Requiere Node 24, `npm ci`, `npm run build` y el vault ya configurado bajo la misma cuenta Windows (DPAPI CurrentUser), o los secretos portables ya existentes. Lee el `.env` de la raíz del repo sin sobreescribir variables del entorno. No crea secretos ni cambia aprobaciones.

Desde PowerShell en la raíz del repo, después de actualizar:

```powershell
git pull
npm ci
npm run build
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\install-autostart.ps1 -Force -Start
```

El último comando instala o reemplaza la tarea y la inicia ahora. También arrancará al iniciar sesión. No se necesita una terminal abierta. Usa `node.exe` por ruta absoluta, no el alias de Git Bash ni un wrapper de terminal. El launcher cierra stdin (equivalente a NUL), oculta la ventana, espera a Node y devuelve su código de salida al Planificador. No ejecuta un proceso separado que haga parecer sana una tarea ya muerta.

La tarea usa la cuenta que la instala, `LogonType Interactive` y `RunLevel Limited`, nunca SYSTEM ni sesión 0. No tiene límite de 72 horas, permite batería, evita dos instancias y reintenta caídas al minuto (hasta 999). No detecta un proceso vivo pero colgado. La vigilancia continua por heartbeat no queda instalada con este script.

No se han probado aquí un escritorio, micrófono ni la cuenta real del PC. CI prueba el launcher con Node y stdin cerrado, rutas con espacios/apóstrofo y salidas 0/no cero, sin registrar tareas reales. Registrar la tarea y confirmar el latido en el PC sigue siendo la comprobación final.

## Estado y diagnóstico

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\install-autostart.ps1 -Status
Get-Content "$HOME\.local\share\personal-agent\log\launcher.stderr.log" -Tail 40
Get-Item "$HOME\.local\share\personal-agent\agent.heartbeat" | Select-Object LastWriteTime
```

El instalador resuelve `PA_STATE_DIR` con la precedencia del CLI: entorno, `.env` del repo, ruta predeterminada. Solo guarda la ruta efectiva, nunca secretos. Si usas `PA_STATE_DIR`, los logs y el heartbeat están ahí. La tarea conserva esa ruta al instalarla, no guarda secretos en sus argumentos. `launcher.stderr.log` recoge la causa real de un fallo de arranque y el exit code; `launcher.stdout.log` recoge stdout. Se conserva una copia anterior si superan 10 MB al volver a arrancar. No limita el crecimiento dentro de una ejecución larga. El launcher rechaza owner distinto, ACL compartida y reparse points antes de escribir o rotar; los directorios nuevos se crean con ACL privada. No cambia permisos de rutas existentes. Una ruta rechazada requiere que revises sus permisos, no ejecutar como administrador. Los logs pueden contener datos privados: no los publiques sin revisar. Los logs JSON diarios del daemon siguen en `log\`.

En `taskschd.msc` busca `personal-agent-daemon` dentro de la carpeta del usuario. Estado Running y resultado `0x41301` significan que sigue en marcha, no un fallo. Un heartbeat reciente solo prueba el proceso, no conectividad con Telegram ni el modelo. Para un diagnóstico adicional: `node dist/cli.js doctor`.

Si persiste el mensaje `stdin is not a tty`, no está demostrado que lo emita serve. Este launcher evita el wrapper de shell y deja stderr real para distinguirlo. No pide contraseñas interactivas ni fuerza autorizaciones. Las acciones que necesitan aprobación siguen bloqueadas sin un aprobador válido.

## Quitar la tarea

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\install-autostart.ps1 -Uninstall
```

La para y borra; no borra vault, logs ni bases de datos. `-Status` solo consulta. `-TaskName`, `-RepoDir` y `-NodeExe` permiten indicar nombre/rutas; `-Force` reemplaza y `-Start` inicia ahora. El directorio del repo debe ser escribible solo por usuarios de confianza: la tarea ejecuta su código con tu cuenta. No eleves el daemon para corregir un permiso del instalador sin revisar la causa.
