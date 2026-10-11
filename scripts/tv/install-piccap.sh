#!/bin/sh
# install-piccap.sh - instala PicCap (org.webosbrew.piccap) 0.5.3 en la TV.
# Contratos verificados 12/10 (auditor R3 + fuentes):
# - hbchannel.service/install exige ipkUrl + ipkHash; completion real =
#   {statusText:"Finished.", finished:true} (NO statusValue 30, que es el
#   packageInstall interno).
# - Digest OFICIAL del release (GitHub API, observado por el auditor):
#   sha256 ad6b0676...38e486. Se verifica contra los bytes descargados.
# Uso: sh scripts/tv/install-piccap.sh <ip-tv> [usuario]
set -eu
TV="${1:?uso: sh install-piccap.sh <ip-tv> [usuario]}"
USER="${2:-root}"
IPK_URL="https://github.com/TBSniller/piccap/releases/download/0.5.3/org.webosbrew.piccap_0.5.3_all.ipk"
IPK_HASH_OFICIAL="ad6b06766cea01dbe8ea0ac9dbbbd9c1a6c030e72df6cd96214199f50d38e486"

# Descarga verificada ANTES de hashear (sin pipefail no vale: fichero + exit).
DL=$(mktemp)
trap rm -f  EXIT
curl -fsSL "$IPK_URL" -o "$DL" || { echo "descarga fallo: $IPK_URL"; exit 1; }
[ -s "$DL" ] || { echo "descarga vacia"; exit 1; }
IPK_HASH=$(sha256sum "$DL" | cut -d" " -f1)
[ "$IPK_HASH" = "$IPK_HASH_OFICIAL" ] || { echo "HASH NO COINCIDE: $IPK_HASH != oficial $IPK_HASH_OFICIAL - aborto"; exit 1; }
echo "IPK verificado contra digest oficial."

ssh "$USER@$TV" sh -s "$IPK_URL" "$IPK_HASH" <<'REMOTE'
set -eu
IPK_URL="$1"; IPK_HASH="$2"
# Prerequisito FAIL-CLOSED: webOS >= 4.0; si no puedo leer la version, aborto.
[ -r /var/run/nyx/os_info.json ] || { echo "no puedo leer /var/run/nyx/os_info.json - aborto (fail-closed)"; exit 1; }
REL=$(grep -o "\"webos_release\"[^,]*" /var/run/nyx/os_info.json | grep -o "[0-9.]*" | cut -d. -f1)
[ -n "$REL" ] || { echo "webos_release ilegible - aborto (fail-closed)"; exit 1; }
[ "$REL" -ge 4 ] || { echo "webOS $REL < 4.0: piccap 0.5.3 no soportado"; exit 1; }

rm -f /tmp/piccap-install.out
luna-send -n 500 -f luna://org.webosbrew.hbchannel.service/install \
  "{\"id\":\"org.webosbrew.piccap\",\"ipkUrl\":\"$IPK_URL\",\"ipkHash\":\"$IPK_HASH\",\"subscribe\":true}" \
  > /tmp/piccap-install.out 2>&1 &
LPID=$!
i=0; OK=0
while [ "$i" -lt 24 ]; do
  if grep -q "\"finished\":true" /tmp/piccap-install.out || grep -q "Finished\." /tmp/piccap-install.out; then OK=1; break; fi
  if grep -q "\"returnValue\":false" /tmp/piccap-install.out || grep -q "errorCode" /tmp/piccap-install.out; then break; fi
  kill -0 $LPID 2>/dev/null || break
  sleep 5; i=$((i + 1))
done
kill $LPID 2>/dev/null || true
[ "$OK" = "1" ] || { echo "install NO termino en exito. Cola:"; tail -5 /tmp/piccap-install.out; exit 1; }

# Verificacion final: presente Y version objetivo.
sleep 2
luna-send -n 1 -f luna://com.webos.applicationManager/listLaunchPoints "{}" | grep -q org.webosbrew.piccap \
  || { echo "finished pero no aparece en launchPoints"; exit 1; }
INFO=$(luna-send -n 1 -f luna://com.webos.applicationManager/getAppInfo "{\"id\":\"org.webosbrew.piccap\"}" 2>/dev/null || true)
echo "$INFO" | grep -q "0.5.3" && echo "piccap 0.5.3: INSTALADO Y VERIFICADO" \
  || echo "piccap instalado; version no legible por getAppInfo (verificar en la UI de PicCap)"
REMOTE
