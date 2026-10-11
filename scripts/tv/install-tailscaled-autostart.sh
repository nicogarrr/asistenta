#!/bin/sh
# install-tailscaled-autostart.sh - autostart de tailscaled (webosbrew init.d).
# R7: pre-state con quoting seguro (multi-PID no rompe el source) y kill PID a
# PID. Rollback desde templates/tailscaled-rollback.sh (test mock 8/8) con
# set -e y fallos visibles (nada de "rollback hecho" falso). Ownership real: Antes de mutar captura el estado previo
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
SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
scp "$SCRIPT_DIR/templates/tailscaled-rollback.sh" "$USER@$TV:/home/root/.tailscaled-rollback.tmpl"
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
# Pre-state a fichero + rollback generado desde el template testeado.
RB=/home/root/tailscaled-autostart-rollback-$TS.sh
STATE=/home/root/tailscaled-autostart-$TS.state
printf 'PRE_PID="%s"\nPRE_DNS=%s\nPRE_INIT=%s\n' "$PRE_PID" "$PRE_DNS" "$PRE_INIT" > "$STATE"
sed -e "s|__STATE__|$STATE|g" -e "s|__BAK__|/var/lib/webosbrew/init.d/tailscaled.bak-$TS|g" \
  /home/root/.tailscaled-rollback.tmpl > "$RB"
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
