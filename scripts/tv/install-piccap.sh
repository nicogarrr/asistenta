#!/bin/sh
# install-piccap.sh - instala PicCap (org.webosbrew.piccap) en la TV desde el repo
# oficial webosbrew, via el servicio de Homebrew Channel por luna-send.
# Uso: sh install-piccap.sh <ip-tv> [usuario]
# Requisitos en la TV: root + Homebrew Channel actualizado + webOS >= 3.4.
set -eu
TV="${1:?uso: sh install-piccap.sh <ip-tv> [usuario]}"
USER="${2:-root}"
ssh "$USER@$TV" sh -s <<'REMOTE'
set -eu
luna-send -n 1 -f luna://org.webosbrew.hbchannel.service/install \
  '{"id":"org.webosbrew.piccap","ipkUrl":"https://repo.webosbrew.org/apps/org.webosbrew.piccap/org.webosbrew.piccap_latest_all.ipk"}' \
  || { echo "fallo el install por hbchannel"; exit 1; }
sleep 10
if luna-send -n 1 -f luna://com.webos.applicationManager/listLaunchPoints '{}' | grep -q org.webosbrew.piccap; then
  echo "piccap: INSTALADO"
else
  echo "piccap: no aparece en launchPoints - revisar en la UI de Homebrew"; exit 1
fi
REMOTE
echo "Tras instalar: abrir PicCap en la tele, esperar a que eleve permisos (mensaje abajo-derecha),"
echo "y configurar receptor: IP de la VM tailscale 100.108.180.24, puerto flatbuffers 19400 (HyperHDR)."
