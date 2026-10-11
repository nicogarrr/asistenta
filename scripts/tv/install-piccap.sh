#!/bin/sh
# install-piccap.sh - instala PicCap (org.webosbrew.piccap) en la TV.
# Contrato verificado (12/10, webos-homebrew-channel services/service.ts):
# hbchannel.service/install EXIGE ipkUrl + ipkHash (sha256) y la instalacion es
# asincrona: hay que SUSCRIBIRSE y esperar statusValue 30 (finished). -n 1 leeria
# solo el primer "Downloading", que NO es exito.
# Uso: sh scripts/tv/install-piccap.sh <ip-tv> [usuario]
set -eu
TV="${1:?uso: sh install-piccap.sh <ip-tv> [usuario]}"
USER="${2:-root}"

# Release observada (GitHub API, 12/10): 0.5.3. El hash se calcula AL EJECUTAR
# descargando el IPK: no hardcodeamos un digest que no podemos verificar aqui.
IPK_URL="https://github.com/TBSniller/piccap/releases/download/0.5.3/org.webosbrew.piccap_0.5.3_all.ipk"
echo "Descargando IPK para calcular sha256..."
IPK_HASH=$(curl -fsSL "$IPK_URL" | sha256sum | cut -d' ' -f1)
[ -n "$IPK_HASH" ] || { echo "no pude calcular el hash"; exit 1; }
echo "sha256=$IPK_HASH"

ssh "$USER@$TV" sh -s "$IPK_URL" "$IPK_HASH" <<'REMOTE'
set -eu
IPK_URL="$1"; IPK_HASH="$2"
# Prerequisito: webOS >= 4.0 (manifiesto piccap 0.5.3).
if [ -r /var/run/nyx/os_info.json ]; then
  REL=$(grep -o '"webos_release"[^,]*' /var/run/nyx/os_info.json | grep -o '[0-9.]*' | cut -d. -f1)
  [ "${REL:-0}" -ge 4 ] || { echo "webOS $REL < 4.0: piccap 0.5.3 no soportado"; exit 1; }
fi
# Suscripcion real al progreso: -n 400 recoge bastantes respuestas; grep decide.
OUT=$(luna-send -n 400 -f luna://org.webosbrew.hbchannel.service/install \
  "{\"id\":\"org.webosbrew.piccap\",\"ipkUrl\":\"$IPK_URL\",\"ipkHash\":\"$IPK_HASH\",\"subscribe\":true}" 2>&1 &
  LPID=$!; sleep 90; kill $LPID 2>/dev/null; wait $LPID 2>/dev/null) || true
# Verificacion real de estado final: el app queda en launchPoints.
sleep 3
if luna-send -n 1 -f luna://com.webos.applicationManager/listLaunchPoints '{}' \
   | grep -q org.webosbrew.piccap; then
  echo "piccap: INSTALADO y presente en launchPoints"
else
  echo "piccap: NO instalado. Salida del install:"; echo "$OUT" | tail -5
  echo "Camino manual: UI de Homebrew -> buscar PicCap -> install"
  exit 1
fi
REMOTE
echo "Abrir PicCap en la tele: esperar elevate (mensaje abajo-derecha) y configurar"
echo "receptor = IP tailscale de la VM AL EJECUTAR (tailscale ip -4), puerto 19400."
