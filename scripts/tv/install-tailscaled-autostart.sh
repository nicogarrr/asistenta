#!/bin/sh
# install-tailscaled-autostart.sh - autostart de tailscaled (webosbrew init.d).
# R5: rollback con ownership real. Antes de mutar captura el estado previo
# (init existente, pid de tailscaled, mount de resolv.conf) y el script de
# rollback generado solo deshace lo que ESTA instalacion hizo:
# - mata tailscaled SOLO si no habia ninguno corriendo antes;
# - desmonta /etc/resolv.conf SOLO si el mount no existia antes;
# - si habia init previo lo restaura y lo relanza (no deja el servicio caido).
# Ademas: rollback script verificado ejecutable ANTES de mutar y rollback
# automatico si la verificacion final falla.
# Uso: sh scripts/tv/install-tailscaled-autostart.sh <ip-tv> [usuario]
set -eu
TV="${1:?uso: sh scripts/tv/install-tailscaled-autostart.sh <ip-tv> [usuario]}"
USER="${2:-root}"
ssh "$USER@$TV" sh -s <<'REMOTE_EOF'
set -eu
[ "$(id -u)" = "0" ] || { echo "necesito root en la TV"; exit 1; }
[ -x /media/developer/bin/tailscaled ] || { echo "tailscaled no esta en /media/developer/bin"; exit 1; }
mkdir -p /var/lib/webosbrew/init.d
TS=$(date +%Y%m%d-%H%M%S)
# Estado PREVIO (ownership)
PRE_INIT=0; [ -e /var/lib/webosbrew/init.d/tailscaled ] && PRE_INIT=1
PRE_PID=$(pidof tailscaled 2>/dev/null || true)
PRE_DNS=0; grep -q ' /etc/resolv.conf ' /proc/mounts 2>/dev/null && PRE_DNS=1
echo "pre-state: init=$PRE_INIT pid='${PRE_PID:-ninguno}' dns_montado=$PRE_DNS"
# Rollback script generado con el ownership horneado. Verificado ANTES de mutar.
RB=/home/root/tailscaled-autostart-rollback-$TS.sh
{
  echo '#!/bin/sh'
  echo "# Rollback del autostart de tailscaled (generado $TS)."
  echo '# Pre-state: init='"$PRE_INIT"' pid='"${PRE_PID:-ninguno}"' dns='"$PRE_DNS"
  if [ -n "$PRE_PID" ]; then
    echo "echo 'habia tailscaled previo (pid $PRE_PID): NO se mata'"
  else
    echo 'PID=$(pidof tailscaled 2>/dev/null) && kill "$PID" 2>/dev/null || true'
    echo 'sleep 1'
    echo 'pidof tailscaled >/dev/null 2>&1 && echo "AVISO: tailscaled sigue vivo" || true'
  fi
  if [ "$PRE_DNS" = "0" ]; then
    echo 'umount /etc/resolv.conf 2>/dev/null || true'
  else
    echo "echo 'resolv.conf ya estaba montado antes: NO se desmonta'"
  fi
  if [ "$PRE_INIT" = "1" ]; then
    echo "mv /var/lib/webosbrew/init.d/tailscaled.bak-$TS /var/lib/webosbrew/init.d/tailscaled"
    echo '# Relanzar el init previo restaurado (idempotente: no duplica el daemon).'
    echo '/var/lib/webosbrew/init.d/tailscaled || true'
  else
    echo 'rm -f /var/lib/webosbrew/init.d/tailscaled'
  fi
  echo 'echo "rollback hecho"'
} > "$RB"
chmod +x "$RB"
[ -x "$RB" ] || { echo "rollback script NO creado - aborto ANTES de mutar"; exit 1; }
# A partir de aqui, cualquier fallo ejecuta el rollback automaticamente.
rollback() {
  echo "FALLO - ROLLBACK AUTOMATICO"
  if ! sh "$RB"; then echo "EL ROLLBACK TAMBIEN FALLO: revisar a mano"; fi
  exit 1
}
[ "$PRE_INIT" = "1" ] && cp -a /var/lib/webosbrew/init.d/tailscaled "/var/lib/webosbrew/init.d/tailscaled.bak-$TS"
cat > /var/lib/webosbrew/init.d/.tailscaled.staged <<'INIT_EOF'
#!/bin/sh
# Arranque de tailscaled (webosbrew init.d). POSIX, fail-closed, idempotente.
set -eu
export PATH=/media/developer/bin:/usr/sbin:/usr/bin:/sbin:/bin
if ! grep -q ' /etc/resolv.conf ' /proc/mounts; then
  cp /etc/resolv.conf /tmp/resolv.conf
  mount -o bind /tmp/resolv.conf /etc/resolv.conf
  grep -q ' /etc/resolv.conf ' /proc/mounts || { echo "mount resolv.conf fallo" >&2; exit 1; }
fi
if ! pidof tailscaled >/dev/null 2>&1; then
  /media/developer/bin/tailscaled > /tmp/tailscaled.log 2>&1 &
fi
INIT_EOF
chmod +x /var/lib/webosbrew/init.d/.tailscaled.staged || rollback
mv /var/lib/webosbrew/init.d/.tailscaled.staged /var/lib/webosbrew/init.d/tailscaled || rollback
/var/lib/webosbrew/init.d/tailscaled || rollback
sleep 3
pidof tailscaled >/dev/null || { echo "tailscaled: NO ARRANCA - /tmp/tailscaled.log"; rollback; }
if /media/developer/bin/tailscale status >/dev/null 2>&1; then
  echo "tailscaled: CORRIENDO Y FUNCIONAL"
else
  sleep 10
  if /media/developer/bin/tailscale status >/dev/null 2>&1; then
    echo "tailscaled: CORRIENDO Y FUNCIONAL"
  else
    echo "tailscaled: NO FUNCIONAL"
    rollback
  fi
fi
echo "Rollback manual: sh $RB"
REMOTE_EOF
echo "Verifica desde la VM: tailscale status | grep -i lgwebostv"
