# TV webOS — scripts de aprovisionamiento (WIP, rama draft)

Scripts de trabajo para la LG C5 (webOS) de Nico: acceso por Telnet (puerto 23,
abierto por el exploit de Homebrew Channel) para preparar SSH (dropbear) y
tailscaled. **No forman parte del daemon ni del CLI de asistenta**: se ejecutan
a mano desde el PC de Nico.

## Configuración

- `TV_IP`: IP de la TV (por defecto `192.168.1.237`). Todos los scripts la leen
  de la variable de entorno; `dualbro.mjs` y `telnet-check.mjs` también la
  aceptan como `argv[2]`.
- `DUALBRO_CHROME_PROFILE`: perfil de Chrome para `dualbro.mjs`
  (por defecto `C:\Temp\chrome-dualbro`).

## Inventario y estado

Soportado (usado en el aprovisionamiento 2026-10):
- `tv-telnet.ps1` — cliente Telnet con lectura a nivel de byte (base del resto).
- `tv-install.ps1` — instala tailscaled y verifica sha256 contra el .sha256 oficial.
- `tv-dropbear.ps1`, `tv-start.ps1`, `tv-stage.ps1`, `tv-up.ps1` — pasos de SSH/arranque.
- `tv-checksum.ps1`, `tv-tools.ps1` — verificaciones.
- `rc.mjs`, `rootcheck.mjs`, `telnet-check.mjs` — checks rápidos por Telnet.
- `tvstate.mjs` — estado vía API de la TV (usa `dist/` compilado del repo).
- `init-quickstart.sh` — mantiene Quick Start apagado (corre EN la TV).
- `dualbro.mjs` — helper Playwright del navegador de la TV (scratch local).

Eliminados en la limpieza: `daemon.err` (warnings SQLite) y `dualbro.err`
(vacío), y las iteraciones viejas duplicadas `rc.mjs`, `tv-install.ps1`,
`tv-tools.ps1`, `tv-telnet.ps1` (se conserva la iteración nueva de cada una,
con su nombre limpio).

## root-setup.mjs — BLOQUEADO (no ejecutar)

El script existe pero está fail-closed (sale con error salvo
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

## Pendiente antes de salir de draft

- Rehacer `root-setup.mjs` como se describe arriba.
- Autostart de tailscaled en la TV (init.d de webOS Homebrew).
- piccap + magic_mapper desde el repo webOSbrew (por SSH, ya sin Telnet).
