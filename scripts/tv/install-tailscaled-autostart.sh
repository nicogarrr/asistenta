#!/bin/sh
# install-tailscaled-autostart.sh - autostart de tailscaled en la TV (webosbrew init.d).
# POSIX puro, idempotente, con backup del init previo, init fail-closed y
# verificacion real del daemon (tailscale status, no solo pid).
# Uso: sh scripts/tv/install-tailscaled-autostart.sh <ip-tv> [usuario]
set -eu
TV="${1:?uso: sh install-tailscaled-autostart.sh <ip-tv> [usuario]}"
USER="${2:-root}"
ssh "$USER@$TV" sh -s <<'REMOTE'
set -eu
[ "$(id -u)" = "0" ] || { echo "necesito root en la TV"; exit 1; }
[ -x /media/developer/bin/tailscaled ] || { echo "tailscaled no esta en /media/developer/bin"; exit 1; }
mkdir -p /var/lib/webosbrew/init.d
TS=$(date +%Y%m%d-%H%M%S)
[ -e /var/lib/webosbrew/init.d/tailscaled ] && cp -a /var/lib/webosbrew/init.d/tailscaled "/var/lib/webosbrew/init.d/tailscaled.bak-$TS"
cat > /var/lib/webosbrew/init.d/tailscaled.new <<'INIT'
#!/bin/sh
# Arranque de tailscaled (webosbrew init.d). POSIX, fail-closed.
set -eu
export PATH=/media/developer/bin:/usr/sbin:/usr/bin:/sbin:/bin
if ! grep -q " /etc/resolv.conf " /proc/mounts; then
  cp /etc/resolv.conf /tmp/resolv.conf
  mount -o bind /tmp/resolv.conf /etc/resolv.conf
  grep -q " /etc/resolv.conf " /proc/mounts || { echo "mount resolv.conf fallo" >&2; exit 1; }
fi
if ! pidof tailscaled >/dev/null 2>&1; then
  /media/developer/bin/tailscaled > /tmp/tailscaled.log 2>&1 &
fi
INIT
chmod +x /var/lib/webosbrew/init.d/tailscaled.new
mv /var/lib/webosbrew/init.d/tailscaled.new /var/lib/webosbrew/init.d/tailscaled
/var/lib/webosbrew/init.d/tailscaled
sleep 3
# Verificacion real: pid Y el CLI responde (daemon funcional, no solo vivo).
pidof tailscaled >/dev/null || { echo "tailscaled: NO ARRANCA - /tmp/tailscaled.log"; exit 1; }
if /media/developer/bin/tailscale status >/dev/null 2>&1; then
  echo "tailscaled: CORRIENDO Y FUNCIONAL"
else
  echo "tailscaled: pid vivo pero CLI no responde aun - recheck en 10s"
  sleep 10
  /media/developer/bin/tailscale status >/dev/null 2>&1 && echo "tailscaled: CORRIENDO Y FUNCIONAL" || { echo "tailscaled: NO FUNCIONAL"; exit 1; }
fi
REMOTE
echo "Rollback: ssh $USER@$TV \"umount /etc/resolv.conf 2>/dev/null; kill \\$(pidof tailscaled); mv /var/lib/webosbrew/init.d/tailscaled.bak-<ts> /var/lib/webosbrew/init.d/tailscaled 2>/dev/null || rm /var/lib/webosbrew/init.d/tailscaled\""
echo "Verifica desde la VM: tailscale status | grep -i lgwebostv"
