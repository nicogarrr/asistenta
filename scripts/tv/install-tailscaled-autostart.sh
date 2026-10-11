#!/bin/sh
# install-tailscaled-autostart.sh - autostart de tailscaled (webosbrew init.d).
# R4: backup del init previo, init fail-closed, verificacion funcional
# (tailscale status) y rollback como script remoto real (sin interpolacion local).
# Uso: sh scripts/tv/install-tailscaled-autostart.sh <ip-tv> [usuario]
set -eu
TV="${1:?uso: sh install-tailscaled-autostart.sh <ip-tv> [usuario]}"
USER="${2:-root}"
ssh "$USER@$TV" sh -s <<'REMOTE_EOF'
set -eu
[ "$(id -u)" = "0" ] || { echo "necesito root en la TV"; exit 1; }
[ -x /media/developer/bin/tailscaled ] || { echo "tailscaled no esta en /media/developer/bin"; exit 1; }
mkdir -p /var/lib/webosbrew/init.d
TS=$(date +%Y%m%d-%H%M%S)
[ -e /var/lib/webosbrew/init.d/tailscaled ] && cp -a /var/lib/webosbrew/init.d/tailscaled "/var/lib/webosbrew/init.d/tailscaled.bak-$TS"
cat > /var/lib/webosbrew/init.d/.tailscaled.staged <<'INIT_EOF'
#!/bin/sh
# Arranque de tailscaled (webosbrew init.d). POSIX, fail-closed.
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
chmod +x /var/lib/webosbrew/init.d/.tailscaled.staged
mv /var/lib/webosbrew/init.d/.tailscaled.staged /var/lib/webosbrew/init.d/tailscaled
# Script de rollback REAL remoto (nada de comandos con $(pidof) interpolados).
cat > /home/root/tailscaled-autostart-rollback-$TS.sh <<RB
#!/bin/sh
# Rollback del autostart de tailscaled (generado $TS).
umount /etc/resolv.conf 2>/dev/null || true
PID=\$(pidof tailscaled 2>/dev/null) && kill "\$PID" 2>/dev/null || true
if [ -e /var/lib/webosbrew/init.d/tailscaled.bak-$TS ]; then
  mv /var/lib/webosbrew/init.d/tailscaled.bak-$TS /var/lib/webosbrew/init.d/tailscaled
else
  rm -f /var/lib/webosbrew/init.d/tailscaled
fi
RB
chmod +x /home/root/tailscaled-autostart-rollback-$TS.sh
/var/lib/webosbrew/init.d/tailscaled
sleep 3
pidof tailscaled >/dev/null || { echo "tailscaled: NO ARRANCA - /tmp/tailscaled.log"; exit 1; }
if /media/developer/bin/tailscale status >/dev/null 2>&1; then
  echo "tailscaled: CORRIENDO Y FUNCIONAL"
else
  sleep 10
  /media/developer/bin/tailscale status >/dev/null 2>&1 \
    && echo "tailscaled: CORRIENDO Y FUNCIONAL" \
    || { echo "tailscaled: NO FUNCIONAL - rollback: sh /home/root/tailscaled-autostart-rollback-$TS.sh"; exit 1; }
fi
echo "Rollback manual: sh /home/root/tailscaled-autostart-rollback-$TS.sh"
REMOTE_EOF
echo "Verifica desde la VM: tailscale status | grep -i lgwebostv"
