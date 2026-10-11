#!/bin/sh
# Rollback del autostart de tailscaled (generado desde templates/tailscaled-rollback.sh).
# Lee el pre-state guardado por la instalacion y deshace SOLO lo que ella hizo.
# Todo fallo es visible (set -e): si algo no se deshace, el script aborta y lo dice.
set -e
STATE="__STATE__"
. "$STATE"
# PRE_PID vacio = la instalacion lanzo el daemon: matarlo y confirmar.
if [ -z "${PRE_PID:-}" ]; then
  if pidof tailscaled >/dev/null 2>&1; then
    kill "$(pidof tailscaled)"
    sleep 1
    if pidof tailscaled >/dev/null 2>&1; then
      echo "ROLLBACK FALLO: tailscaled sigue vivo tras kill" >&2
      exit 1
    fi
  fi
else
  echo "habia tailscaled previo (pid $PRE_PID): NO se mata"
fi
# PRE_DNS=0 = el mount de resolv.conf lo hizo esta instalacion: desmontarlo.
MOUNTS="${MOUNTS_FILE:-/proc/mounts}"
if [ "${PRE_DNS:-1}" = "0" ]; then
  if grep -q ' /etc/resolv.conf ' "$MOUNTS"; then
    umount /etc/resolv.conf
  fi
else
  echo "resolv.conf ya estaba montado antes: NO se desmonta"
fi
# Init: restaurar el previo (y relanzarlo) o quitar el nuestro.
if [ "${PRE_INIT:-0}" = "1" ]; then
  mv "__BAK__" /var/lib/webosbrew/init.d/tailscaled
  /var/lib/webosbrew/init.d/tailscaled
else
  rm -f /var/lib/webosbrew/init.d/tailscaled
fi
echo "rollback hecho"
