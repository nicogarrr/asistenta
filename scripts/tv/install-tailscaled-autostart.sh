#!/bin/sh
# install-tailscaled-autostart.sh - arregla el autostart de tailscaled en la TV LG rooteada.
# Uso: sh scripts/tv/install-tailscaled-autostart.sh <ip-tv> [usuario]
# POSIX puro (dash en webOS). Idempotente: se puede re-ejecutar sin efectos dobles.
#
# Por que: tailscaled vive en /media/developer/bin pero no arranca solo al encender
# la tele; webosbrew ejecuta los scripts de /var/lib/webosbrew/init.d con run-parts
# al arrancar (nombre valido: solo a-zA-Z0-9-_, sin puntos).
set -eu
TV="${1:?uso: sh install-tailscaled-autostart.sh <ip-tv> [usuario]}"
USER="${2:-root}"
ssh "$USER@$TV" sh -s <<'REMOTE'
set -eu
[ "$(id -u)" = "0" ] || { echo "necesito root en la TV"; exit 1; }
[ -x /media/developer/bin/tailscaled ] || { echo "tailscaled no esta en /media/developer/bin - instala tailscale primero"; exit 1; }
mkdir -p /var/lib/webosbrew/init.d
cat > /var/lib/webosbrew/init.d/tailscaled <<'INIT'
#!/bin/sh
# Arranque de tailscaled (webosbrew init.d). POSIX puro.
# /etc es de solo lectura en webOS y tailscaled necesita escribir resolv.conf:
# copia a /tmp y bind-mount ENCIMA (el original en disco queda intacto; rollback
# = umount /etc/resolv.conf). Idempotente: si ya esta montado, no re-monta.
export PATH=/media/developer/bin:/usr/sbin:/usr/bin:/sbin:/bin
if ! grep -q ' /etc/resolv.conf ' /proc/mounts; then
  cp /etc/resolv.conf /tmp/resolv.conf
  mount -o bind /tmp/resolv.conf /etc/resolv.conf
fi
if ! pidof tailscaled >/dev/null 2>&1; then
  /media/developer/bin/tailscaled > /tmp/tailscaled.log 2>&1 &
fi
INIT
chmod +x /var/lib/webosbrew/init.d/tailscaled
/var/lib/webosbrew/init.d/tailscaled
sleep 3
pidof tailscaled >/dev/null && echo "tailscaled: CORRIENDO" || { echo "tailscaled: NO ARRANCA - ver /tmp/tailscaled.log"; exit 1; }
REMOTE
echo "Autostart instalado en $TV. Verifica desde la VM: tailscale status | grep -i lgwebostv"
