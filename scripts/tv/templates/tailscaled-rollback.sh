#!/bin/sh
# Rollback del autostart de tailscaled (R7, desde templates/tailscaled-rollback.sh).
# Lee el pre-state (con quoting) y deshace SOLO lo propio. set -e: todo fallo visible.
set -e
INITD="${INITD:-/var/lib/webosbrew/init.d}"
MOUNTS="${MOUNTS_FILE:-/proc/mounts}"
STATE="__STATE__"
. "$STATE"
if [ -z "${PRE_PID:-}" ]; then
  if pidof tailscaled >/dev/null 2>&1; then
    for p in $(pidof tailscaled); do
      kill "$p"
    done
    sleep 1
    if pidof tailscaled >/dev/null 2>&1; then
      echo "ROLLBACK FALLO: tailscaled sigue vivo tras kill" >&2
      exit 1
    fi
  fi
else
  echo "habia tailscaled previo (pid $PRE_PID): NO se mata"
fi
if [ "${PRE_DNS:-1}" = "0" ]; then
  if grep -q ' /etc/resolv.conf ' "$MOUNTS"; then
    umount /etc/resolv.conf
  fi
else
  echo "resolv.conf ya estaba montado antes: NO se desmonta"
fi
if [ "${PRE_INIT:-0}" = "1" ]; then
  mv "__BAK__" "$INITD/tailscaled"
  "$INITD/tailscaled"
else
  rm -f "$INITD/tailscaled"
fi
echo "rollback hecho"
