#!/bin/sh
# install-tailscaled-autostart.sh - arregla el autostart de tailscaled en la TV LG rooteada.
# Se ejecuta DESDE cualquier maquina con ssh a la TV:  sh install-tailscaled-autostart.sh <ip-tv>
# Por que: tailscaled vive en /media/developer/bin pero no arranca solo al encender
# la tele; webosbrew ejecuta los scripts de /var/lib/webosbrew/init.d con run-parts
# al arrancar. Nombre valido para run-parts: solo a-zA-Z0-9-_ (sin puntos).
set -eu
TV="${1:?uso: sh install-tailscaled-autostart.sh <ip-tv> [usuario]}"
USER="${2:-root}"
ssh "$USER@$TV" sh -s <<'REMOTE'
set -eu
mkdir -p /var/lib/webosbrew/init.d
cat > /var/lib/webosbrew/init.d/tailscaled <<'INIT'
#!/bin/sh
# Arranque de tailscaled (webosbrew init.d). El bind-mount de resolv.conf es
# necesario: /etc es de solo lectura en webOS y tailscaled necesita escribirlo.
export PATH=/media/developer/bin:/usr/sbin:/usr/bin:/sbin:/bin
cp /etc/resolv.conf /tmp/resolv.conf
mount -o bind /tmp/resolv.conf /etc/resolv.conf
/media/developer/bin/tailscaled &> /tmp/tailscaled.log &
INIT
chmod +x /var/lib/webosbrew/init.d/tailscaled
# Arrancar ahora si no esta corriendo ya.
if ! pidof tailscaled >/dev/null 2>&1; then
  /var/lib/webosbrew/init.d/tailscaled || true
fi
sleep 3
pidof tailscaled >/dev/null && echo "tailscaled: CORRIENDO" || { echo "tailscaled: NO ARRANCA - ver /tmp/tailscaled.log"; exit 1; }
REMOTE
echo "Autostart instalado en $TV. Verifica desde la VM: tailscale status | grep -i lgwebostv"
