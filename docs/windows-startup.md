# Arranque completo de Windows

Se activa solo con una instalación explícita, bajo el usuario actual, sin SYSTEM ni elevación por defecto. No hay auto-instalación al ejecutar `serve` ni botón que cambie tareas sin confirmación.

Después de `git pull`, `npm ci` y `npm run build`, un comando:

```powershell
node dist/cli.js autostart install --start
```

O directamente `powershell -NoProfile -ExecutionPolicy Bypass -File deploy/windows/install-all.ps1 -Start`.

Requisitos ya preparados: Node >=24, vault DPAPI configurado con Telegram y allowlist, y `deploy/browserd/setup-browserd.ps1` completado (venv + navegadores). El instalador valida archivos antes de registrar nada; no descarga runtimes, no pide claves y no aprovisiona el contenedor.

## Antes de instalar: `pa iniciar`

```powershell
node dist/cli.js iniciar --solo-comprobar
```

Repasa de una vez lo que necesita el daemon y lo pinta en verde/rojo con el arreglo de cada fallo: Node 24, vault, token de Telegram (lo valida contra Telegram), usuarios autorizados, claves del modelo (sin gastar llamadas), tele (solo abre y cierra una conexión a los puertos 3001/3000 de webOS, no manda órdenes), Computer Use, correo y espacio en disco. Tele, correo y Computer Use son opcionales: salen como aviso, no impiden arrancar.

- Sin `--solo-comprobar`, si no hay ningún ❌ arranca el daemon igual que `pa serve`.
- `--sin-red` no toca Telegram ni la tele; `--json` da la lista en JSON.
- Código de salida: 0 listo (aunque haya avisos), 1 algo impide arrancar, 2 opción desconocida.

## Qué arranca

Dos tareas AtLogOn en la carpeta del usuario: `browserd-sidecar` y `personal-agent-daemon`. Son Limited/Interactive, ocultas y `IgnoreNew`. Reinstalar reemplaza las definiciones, no añade copias ni mata una instancia activa. Si se cambia configuración con una instancia activa, tendrá efecto en su siguiente arranque. `--start` solo inicia tareas que no están Running.

El launcher intenta browserd primero y espera su contrato `/health` hasta unos 20 s (peticiones con timeout 2 s). Después intenta Docker Desktop, comprueba `docker info` y hace `docker start asistenta-opencode` sobre el contenedor existente. Espera `/global/health` en 4096 con timeout. El [contrato oficial OpenCode](https://opencode.ai/docs/server/) es `{healthy:true,version:string}`; no es una inferencia a partir de que el puerto esté abierto.

Docker/LLM queda habilitado por defecto según la decisión de Nico. Docker Desktop puede quedar residente. Para quitar esa parte explícitamente:

```powershell
node dist/cli.js autostart install --no-local-llm
```

El contenedor debe haberse preparado con el launcher aislado existente de `scripts/opencode-local/serve-windows.ps1`. Este arranque no crea ni elimina contenedores, no descarga imágenes, no copia credenciales ni monta carpetas nuevas. Antes de arrancarlo valida la imagen fijada, no privileged/host network, único puerto 127.0.0.1:4096 y exactamente auth.json RO + /work RW en las rutas dedicadas por defecto. Una jaula personalizada no se adopta silenciosamente.

Si falta Docker, el contenedor, browserd o LLM, el launcher sigue a `serve` y marca el LLM como no disponible. Los plazos son acotados por operación: browserd ~22 s, Docker info/Desktop ~55 s y salud LLM ~32 s, más inspect/start. No se garantiza un arranque instantáneo. Telegram/vault/red siguen siendo requisitos propios de `serve`; esto no salta validaciones de autenticación. La construcción de opencode-local no llama al modelo. `/estado` informa del LLM local actual y modo degradado sin realizar una llamada de inferencia.

## Estado único, sin secretos

```powershell
node dist/cli.js autostart status
```

Devuelve JSON: tareas instaladas/Running y último código, edad del heartbeat, browserd 7701 (contrato), OpenCode 4096 (contrato), listener TV 8765 (health). No vuelca argumentos, `.env`, tokens, docker inspect, direcciones de destinatarios ni cuerpos de errores remotos. `8765` sano prueba el listener local, no la TV ni la instalación de su botón.

## Supervisor externo real

El launcher PowerShell está fuera del event-loop Node. Conserva el objeto `Process` real que creó y una exclusión `FileShare.None` por estado. No lee `agent.pid` para terminar procesos.

Tras 180 s de gracia, un heartbeat de esta instancia con más de 120 s activa recuperación. Heartbeat ausente, futuro o anterior a esta instancia: aviso, nunca matar por una suposición. Una lectura sana no toca procesos.

1. Consume y guarda un intento ANTES de parar, en `log/supervisor-restarts.json` privado. Un fallo de lectura/escritura del presupuesto falla cerrado; no se borra ni reinicia el contador.
2. Intenta `pa stop`, con el control autenticado ya existente y plazo de 40 s.
3. Si no termina tras ese plazo y 5 s adicionales, termina SOLO su hijo mediante el objeto Process. Esto NO es cierre limpio, no fabrica su confirmación y no borra marcadores stale.
4. Sale con código no cero para que Task Scheduler relance la tarea. No lanza un segundo daemon en paralelo.

Tope persistente: 3 intentos por 15 min, también si el stop falló. Si al siguiente lanzamiento el presupuesto sigue agotado, no inicia otro daemon y termina con código 0 para cortar el bucle. Se necesita revisar el problema y arrancar la tarea una vez haya pasado la ventana. No se considera curado por esperar. Los fallos ordinarios de proceso también tienen máximo 3 reintentos por activación en Task Scheduler (antes eran 999). No es un SLA de disponibilidad ni un supervisor del propio PowerShell si este se bloquea.

Los avisos usan un proceso CLI separado, DPAPI y contenido fijo. Van solo al owner explícito allowlisted o al único usuario de la allowlist, nunca un grupo. Red/Telegram/owner no verificado: entrega fallida registrada localmente, no se afirma que llegó y no se reintenta en bucle. Un daemon caído no es necesario para ese aviso.

## Vigilante: «Asistenta-vigilante»

`pa autostart install` registra además una tercera tarea, `Asistenta-vigilante`, que corre al iniciar sesión y cada 5 min. Lanza PowerShell oculto con `node dist/cli.js autostart vigilar` y decide una sola cosa:

- Si Asistenta está en marcha, no hace nada.
- Si no está en marcha, arranca la tarea normal del daemon (`personal-agent-daemon`), la misma del inicio de sesión. Nunca abre una segunda copia.
- Si no puede saber si corre: «no sé si corre: no toco nada».
- Si la paraste con `pa stop`: «la paraste tú: sigue apagada hasta reiniciar el PC o pa iniciar».

La última decisión se guarda en `<estado>/vigilante.json` y sale en `pa autostart status`. Con `PA_WATCHDOG=0` en `.env`, `pa autostart install` no registra el vigilante; si ya estaba registrado, sigue corriendo pero no hace nada («vigilante apagado (PA_WATCHDOG=0)»), y `pa autostart uninstall` lo quita. En los tests `schtasks` va simulado: no se crea ninguna tarea real.

## Parada y desinstalación

`pa stop` conserva la parada limpia autenticada. Si fue una parada voluntaria con exit 0, el launcher no solicita reinicio.

```powershell
node dist/cli.js autostart uninstall
```

Si el daemon está Running, solicita cierre limpio y se niega a quitar tareas si no lo confirma. Luego desregistra las dos definiciones. No usa `Stop-ScheduledTask`, no mata Python arbitrario ni Docker. Un browserd ya activo se deja vivo hasta cierre de sesión o parada manual; desregistrar su tarea no es parar el sidecar. No borra datos, volúmenes, jaula ni Docker Desktop. Para previsualizar una instalación/desinstalación: `--what-if`.

## QA y límites

CI Windows ejecuta el parser PS5 real, canarios con Scheduler/handles simulados, rutas con espacios/apóstrofos, registro repetido sin duplicados, WhatIf sin tareas reales, y los tests del launcher/cierre autenticado. La suite también prueba destinatario fijo/fail-closed y contrato de salud. Esto no equivale a haber reiniciado el Huawei de Nico, capturado su escritorio, accedido a su TV o validado Docker Desktop en su sesión.

Rollback de instalación: si falla el segundo registro se restaura el primero desde su XML previo (o se quita si antes no existía). Una reversión que falle también es fallo visible. No se permite considerar la instalación completada con una excepción oculta.

`pa autostart status` empieza con una línea sobre la última comprobación de `pa iniciar` (cuándo fue, si estaba todo en verde o qué falló). Se guarda en `<estado>/iniciar-ultimo.json` cada vez que corre `pa iniciar`.
