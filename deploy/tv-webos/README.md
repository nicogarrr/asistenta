# Diagnóstico webOS de solo lectura

Rescate pequeño de los diagnósticos de la PR #145, cerrada sin merge. No copia sus instaladores, credenciales por defecto, direcciones de Nico ni scripts que borraban archivos. No sustituye el instalador oficial de `scripts/tv/`.

Después de `npm ci` y `npm run build`:

```sh
node deploy/tv-webos/diagnose.mjs <IPv4-privada-de-la-TV> [puerto]
```

No hay host por defecto. El puerto por defecto es 23. Solo acepta IPv4 privada, loopback o Tailscale. Se usa únicamente cuando el propietario ha abierto una ventana de mantenimiento y la TV ya expone una shell Telnet. Telnet no cifra: solo en una red local de confianza. No abre Telnet ni intenta autenticarse. Si pide login o contraseña, termina sin enviarlos.

Lee `id`, `uname -a`, disponibilidad de `python3`, `curl`, `openssl` y `sha256sum`, y espacio de `/tmp`, `/var` y `/media`. Los comandos son fijos; no hay comandos, rutas o contraseñas del usuario interpolados. No descarga, instala, borra, reinicia, arranca servicios ni cambia botones. No lee claves, tokens, variables de entorno ni logs.

Límite total de cinco segundos y 32 KiB de tráfico recibido. Una desconexión, exceso de salida o falta del marcador final da error, no éxito. El código 0 solo confirma que terminó la lectura, no que la TV esté sana ni que el usuario sea root. La salida es dato no confiable de la TV: los controles de terminal se escapan y el diagnóstico no ejecuta instrucciones que aparezcan en ella. No publicar automáticamente el informe: puede contener nombres de host, usuario y rutas locales.

Verificación: 22 tests dirigidos con servidor TCP loopback (negociación Telnet fragmentada, login rechazado, cierre incompleto, límite de bytes y plazo absoluto, comandos fijos y controles de terminal); typecheck y build. No se conectó a la TV real ni al PC de Nico. La ventana de TV permanece cerrada.
