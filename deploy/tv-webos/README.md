# TV webOS — diagnóstico y aprovisionamiento

Scripts de trabajo para la LG C5 (webOS) de Nico: acceso por Telnet (puerto 23,
abierto por el exploit de Homebrew Channel) para preparar SSH (dropbear) y
tailscaled. **No forman parte del daemon ni del CLI de asistenta**: se ejecutan
a mano desde el PC de Nico. Nada aquí corre automáticamente.

## Configuración

- `TV_IP`: IP de la TV (por defecto `192.168.1.237`, como en el resto del
  repo). `dualbro.mjs` y `telnet-check.mjs` también la aceptan como `argv[2]`.
- `DUALBRO_CHROME_PROFILE`: perfil de Chrome para `dualbro.mjs`
  (por defecto `C:\Temp\chrome-dualbro`).

## Diagnóstico de solo lectura (diagnose.mjs)

Rescate de los diagnósticos de la PR #145, cerrada sin merge. Después de
`npm ci` y `npm run build`:

```sh
node deploy/tv-webos/diagnose.mjs <IPv4-privada-de-la-TV> [puerto]
```

No hay host por defecto. El puerto por defecto es 23. Solo acepta IPv4 privada, loopback o Tailscale. Se usa únicamente cuando el propietario ha abierto una ventana de mantenimiento y la TV ya expone una shell Telnet. Telnet no cifra: solo en una red local de confianza. No abre Telnet ni intenta autenticarse. Si pide login o contraseña, termina sin enviarlos.

Lee `id`, `uname -a`, disponibilidad de `python3`, `curl`, `openssl` y `sha256sum`, y espacio de `/tmp`, `/var` y `/media`. Los comandos son fijos; no hay comandos, rutas o contraseñas del usuario interpolados. No descarga, instala, borra, reinicia, arranca servicios ni cambia botones. No lee claves, tokens, variables de entorno ni logs.

Límite total de cinco segundos y 32 KiB de tráfico recibido. Una desconexión, exceso de salida o falta del marcador final da error, no éxito. El código 0 solo confirma que terminó la lectura, no que la TV esté sana ni que el usuario sea root. La salida es dato no confiable de la TV: los controles de terminal se escapan y el diagnóstico no ejecuta instrucciones que aparezcan en ella. No publicar automáticamente el informe: puede contener nombres de host, usuario y rutas locales.

Verificación: 22 tests dirigidos con servidor TCP loopback (negociación Telnet fragmentada, login rechazado, cierre incompleto, límite de bytes y plazo absoluto, comandos fijos y controles de terminal); typecheck y build. No se conectó a la TV real ni al PC de Nico. La ventana de TV permanece cerrada.

## Inventario de aprovisionamiento

Usado en el aprovisionamiento 2026-10 (telnet 23 → dropbear/SSH y tailscaled):

- `tv-telnet.ps1` — cliente Telnet con lectura a nivel de byte (base del resto).
- `tv-install.ps1` — instala tailscaled y verifica sha256 contra el .sha256 oficial.
- `tv-dropbear.ps1`, `tv-start.ps1`, `tv-stage.ps1`, `tv-up.ps1` — pasos de SSH/arranque.
- `tv-checksum.ps1`, `tv-tools.ps1` — verificaciones.
- `rc.mjs`, `rootcheck.mjs`, `telnet-check.mjs` — checks rápidos por Telnet.
  `rc.mjs` envía un comando arbitrario por argv (uso manual exclusivo) y
  `telnet-check.mjs` exige la contraseña por argv: no hay credencial por defecto.
- `tvstate.mjs` — estado vía API de la TV (usa `dist/` compilado del repo).
- `init-quickstart.sh` — mantiene Quick Start apagado (corre EN la TV).
- `dualbro.mjs` — helper Playwright del navegador de la TV (scratch local).

## root-setup.mjs — BLOQUEADO (no ejecutar)

El script existe pero está fail-closed en el código (sale con error salvo
`TV_ROOT_SETUP_ACK=yes`) porque tal cual es inseguro:
1. La contraseña nueva llega por `argv[2]` y se interpola SIN ESCAPAR en un
   comando de shell enviado por Telnet: inyección de shell y secreto visible
   en `ps`/historial.
2. Sobrescribe `/home/root/.ssh/authorized_keys` sin backup: una clave mal
   pegada deja la TV sin acceso y sin forma de volver.
Antes de usarlo hay que rehacerlo: secreto leído del vault de asistenta
(`dist/vault.js`), validación de la clave pública, backup de
`authorized_keys` con rollback automático si falla, y prueba de login en
sesión aparte antes de cerrar la actual.
