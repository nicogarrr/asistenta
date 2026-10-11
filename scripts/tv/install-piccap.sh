#!/bin/sh
# install-piccap.sh - instala PicCap (org.webosbrew.piccap) 0.5.3 en la TV.
# Contratos (auditor R4, 12/10): hbchannel install exige ipkUrl+ipkHash;
# completion real = "finished":true (returnValue:false tiene prioridad y aborta);
# digest OFICIAL sha256 verificado contra los bytes descargados.
# Uso: sh scripts/tv/install-piccap.sh <ip-tv> [usuario]
set -eu
TV="${1:?uso: sh install-piccap.sh <ip-tv> [usuario]}"
USER="${2:-root}"
IPK_URL="https://github.com/TBSniller/piccap/releases/download/0.5.3/org.webosbrew.piccap_0.5.3_all.ipk"
IPK_HASH_OFICIAL="ad6b06766cea01dbe8ea0ac9dbbbd9c1a6c030e72df6cd96214199f50d38e486"
DL="/tmp/piccap-0.5.3-$$.ipk"

curl -fsSL "$IPK_URL" -o "$DL" || { echo "descarga fallo: $IPK_URL"; rm -f "$DL"; exit 1; }
[ -s "$DL" ] || { echo "descarga vacia"; rm -f "$DL"; exit 1; }
IPK_HASH=$(sha256sum "$DL" | cut -d' ' -f1)
rm -f "$DL"
[ "$IPK_HASH" = "$IPK_HASH_OFICIAL" ] || { echo "HASH NO COINCIDE: $IPK_HASH"; exit 1; }
echo "IPK verificado contra digest oficial."

ssh "$USER@$TV" sh -s "$IPK_URL" "$IPK_HASH" <<'REMOTE_EOF'
set -eu
IPK_URL="$1"; IPK_HASH="$2"
# Prerequisito FAIL-CLOSED: webOS >= 4.0.
[ -r /var/run/nyx/os_info.json ] || { echo "os_info.json ilegible - aborto (fail-closed)"; exit 1; }
REL=$(grep -o '"webos_release"[^,]*' /var/run/nyx/os_info.json | grep -o '[0-9.]*' | cut -d. -f1)
[ -n "$REL" ] || { echo "webos_release ilegible - aborto (fail-closed)"; exit 1; }
[ "$REL" -ge 4 ] || { echo "webOS $REL < 4.0: piccap 0.5.3 no soportado"; exit 1; }

OUT=/tmp/piccap-install.out
rm -f "$OUT"
luna-send -n 500 -f luna://org.webosbrew.hbchannel.service/install \
  "{\"id\":\"org.webosbrew.piccap\",\"ipkUrl\":\"$IPK_URL\",\"ipkHash\":\"$IPK_HASH\",\"subscribe\":true}" \
  > "$OUT" 2>&1 &
LPID=$!
i=0; STATE=""
while [ "$i" -lt 24 ]; do
  # returnValue:false tiene PRIORIDAD: fallo explicito aunque haya finished.
  if grep -qE '"returnValue"[[:space:]]*:[[:space:]]*false' "$OUT"; then STATE=fail; break; fi
  if grep -qE '"finished"[[:space:]]*:[[:space:]]*true' "$OUT"; then STATE=ok; break; fi
  kill -0 $LPID 2>/dev/null || break
  sleep 5; i=$((i + 1))
done
kill $LPID 2>/dev/null || true
[ "$STATE" = "ok" ] || { echo "install sin completion ok ($STATE). Cola:"; tail -5 "$OUT"; exit 1; }

sleep 2
luna-send -n 1 -f luna://com.webos.applicationManager/listLaunchPoints '{}' | grep -q org.webosbrew.piccap \
  || { echo "finished pero no aparece en launchPoints"; exit 1; }
INFO=$(luna-send -n 1 -f luna://com.webos.applicationManager/getAppInfo '{"id":"org.webosbrew.piccap"}' 2>/dev/null || true)
echo "$INFO" | grep -q '"version"[[:space:]]*:[[:space:]]*"0.5.3"' \
  || { echo "version instalada NO verificable como 0.5.3 - unverified"; echo "$INFO" | head -3; exit 1; }
echo "piccap 0.5.3: INSTALADO Y VERIFICADO"
REMOTE_EOF
