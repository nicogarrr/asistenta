# RUNBOOK — Home de Nico (para Asistenta en el PC de Nico)

Reglas duras de Nico para la TV (sin excepciones):
- Mientras ve la tele: SOLO lectura. Nada visible (sin toasts, lanzamientos,
  reinicios de UI). Ventanas explícitas ("tienes 5 min") sí cuentan.
- Adblock apagado por defecto.
- Todo paso con respaldo y deshacer.

Acceso: telnet 192.168.1.237 (puerto 23, root sin login) desde Git Bash en su
PC. SSH pide contraseña y NO acepta sus claves (estado 2026-10-16).

## Paso 0 — preflight (solo lectura, se puede hacer mientras ve la tele)

```sh
# Versión webOS, apps instaladas y launch points reales:
luna-send -n 1 'luna://com.webos.service.tv.systemproperty/getSystemInfo' '{}'
luna-send -n 1 'luna://com.webos.applicationManager/listLaunchPoints' '{}'
```

Guardar la salida en el repo Asistenta (evidencia). Con ella: confirmar los
appId marcados VERIFICAR en `src/lib/apps.ts` y copiar iconos reales a
`public/icons/`.

## Paso 1 — build e instalación de la app (SIN toma del Home)

En el PC (Git Bash, Node 24):

```sh
cd tools/tv-home
npm ci
npm run build
ares-package dist service -o . --no-minify
```

Instalar el .ipk en la TV. Dos vías:
- ares-install (requiere Developer Mode + key server, ya activos), o
- subir el ipk por telnet y usar el servicio del Homebrew Channel
  (`org.webosbrew.hbchannel.service/install`) como hace `installer/tv-install.sh`.

Lanzarla a mano una vez (visible → ventana de Nico) y verificar: navegación,
lanzamiento real de apps, tiempo de Gijón, ambient a los 60 s.

## Paso 2 — toma del botón Home y arranque (visible, ventana de Nico)

`service/autostart.sh` arma el watcher del botón HOME (código 773 en la TV de
referencia — VERIFICAR en la suya en el paso 1 con el log /tmp/home-svc.log) y
el hook init.d `/var/lib/webosbrew/init.d/50-customhome` arranca en boot.

## Deshacer

```sh
sh installer/tv-uninstall.sh   # quita hook init.d + servicio + app
```

El Home de LG nunca se desinstala: vuelve solo al desinstalar esta app.

## Clave TMDB

La mete Nico en la TV: Ajustes → Clave TMDB. Gratis en themoviedb.org →
Settings → API. Vive solo en localStorage de la app. Sin clave todo funciona
menos "Para ti".
