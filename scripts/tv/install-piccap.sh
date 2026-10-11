#!/bin/sh
# install-piccap.sh - instala PicCap (org.webosbrew.piccap) via el servicio de
# Homebrew Channel (install por ID: el servicio resuelve el paquete desde el repo
# oficial; no fijamos URL del IPK para no acoplar a un formato que cambia).
# Uso: sh scripts/tv/install-piccap.sh <ip-tv> [usuario]
# Requisitos en la TV: root + Homebrew Channel actualizado + webOS >= 3.4.
set -eu
TV="${1:?uso: sh install-piccap.sh <ip-tv> [usuario]}"
USER="${2:-root}"
ssh "$USER@$TV" sh -s <<'REMOTE'
set -eu
# La instalacion es ASINCRONA: -n 1 solo devuelve la primera respuesta, no el
# final. Tras lanzarla, esperamos sondeando listLaunchPoints hasta 90 s.
luna-send -n 1 -f luna://org.webosbrew.hbchannel.service/install \
  '{"id":"org.webosbrew.piccap"}' >/dev/null \
  || { echo "fallo al lanzar install por hbchannel"; exit 1; }
i=0
while [ "$i" -lt 18 ]; do
  if luna-send -n 1 -f luna://com.webos.applicationManager/listLaunchPoints '{}' \
     | grep -q org.webosbrew.piccap; then
    echo "piccap: INSTALADO (tras ${i}x5s)"
    exit 0
  fi
  i=$((i + 1))
  sleep 5
done
echo "piccap: no aparece en launchPoints tras 90s - instalar desde la UI de Homebrew"
exit 1
REMOTE
echo "Tras instalar: abrir PicCap en la tele, esperar a que eleve permisos (mensaje"
echo "abajo-derecha) y configurar el receptor: la IP tailscale de la VM al ejecutar"
echo "(verificala con: tailscale ip -4), puerto flatbuffers 19400."
