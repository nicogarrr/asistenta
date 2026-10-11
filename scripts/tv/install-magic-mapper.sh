#!/bin/sh
# install-magic-mapper.sh - despliega magic_mapper v1.1.0. R4:
# - staging en el fs PROPIO de cada destino (rename atomico real);
# - backup total + rollback automatico en CUALQUIER fallo post-backup
#   (restore hace stop primero), y rollback manual como script remoto real;
# - IP LAN estricta (192.168/10/172.16-31/100.64-127, 4 octetos 0-255);
# - prereq evdev probado con import real;
# - el boton solo se activa con --button <nombre> EXPLICITO del operador.
# Uso: sh install-magic-mapper.sh <ip-tv> <ip-laptop> --button <nombre> [usuario]
set -eu
TV="${1:?uso: sh install-magic-mapper.sh <ip-tv> <ip-laptop> --button <nombre> [usuario]}"
LAPTOP="${2:?falta la IP LAN del laptop (asistenta)}"
BTN=""
[ "${3:-}" = "--button" ] && BTN="${4:-}"
USER="${5:-root}"
[ -n "$BTN" ] || { echo "falta --button <nombre> (decision explicita del owner; candidatos: 0-9, guide, info...)"; exit 2; }
echo "$BTN" | grep -qE '^[a-z0-9_]+$' || { echo "nombre de boton invalido: $BTN"; exit 2; }
VERSION="v1.1.0"
BASE="https://raw.githubusercontent.com/andrewfraley/magic_mapper/$VERSION"
SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)

# IP: exactamente 4 octetos 0-255 y rango LAN/tailnet.
O1=$(echo "$LAPTOP" | cut -d. -f1); O2=$(echo "$LAPTOP" | cut -d. -f2)
O3=$(echo "$LAPTOP" | cut -d. -f3); O4=$(echo "$LAPTOP" | cut -d. -f4)
case "$O1.$O2.$O3.$O4" in *[!0-9.]*|*..*|.*|*.) echo "IP mal formada: $LAPTOP"; exit 1;; esac
[ "$(echo "$LAPTOP" | awk -F. '{print NF}')" = "4" ] || { echo "IP debe tener 4 octetos: $LAPTOP"; exit 1; }
for o in "$O1" "$O2" "$O3" "$O4"; do
  case "$o" in ''|*[!0-9]*) echo "octeto no numerico: $o"; exit 1;; esac
  [ "$o" -le 255 ] || { echo "octeto fuera de rango: $o"; exit 1; }
done
PRIVATE=0
[ "$O1" = "192" ] && [ "$O2" = "168" ] && PRIVATE=1
[ "$O1" = "10" ] && PRIVATE=1
[ "$O1" = "172" ] && [ "$O2" -ge 16 ] && [ "$O2" -le 31 ] && PRIVATE=1
[ "$O1" = "100" ] && [ "$O2" -ge 64 ] && [ "$O2" -le 127 ] && PRIVATE=1
[ "$PRIVATE" = "1" ] || { echo "IP no privada/tailnet: $LAPTOP"; exit 1; }

# PREFLIGHT: listener de la asistenta respondiendo (boton sin listener = boton muerto activado).
curl -fsS -m 3 "http://$LAPTOP:8765/tv/button-health" >/dev/null 2>&1 \
  || { echo "listener :8765/tv/button-health NO responde en $LAPTOP - despliega primero la PR del listener"; exit 2; }

# Config local renderizada con boton+URL, validada dos veces antes de subir.
CFG="/tmp/mm-config-$$.json"
sed -e "s|__ASISTENTA_URL__|http://$LAPTOP:8765/tv/button|" -e "s|\"__BUTTON__\"|\"$BTN\"|" \
  "$SCRIPT_DIR/../../config/tv/magic_mapper_config.json" > "$CFG"
python3 -m json.tool "$CFG" >/dev/null || { echo "config renderizada no es JSON valido"; rm -f "$CFG"; exit 1; }
python3 -c "import json;d=json.load(open('$CFG'));assert '$BTN' in d, 'boton no quedo en la config'" || { rm -f "$CFG"; exit 1; }

# 1) STAGING: home en /home/root/.mm-new y init.d en su PROPIO directorio (rename atomico real).
ssh "$USER@$TV" sh -s "$BASE" <<'REMOTE_EOF'
set -eu
BASE="$1"
mkdir -p /var/lib/webosbrew/init.d
command -v python3 >/dev/null || { echo "python3 no existe en la TV"; exit 1; }
python3 -c 'import evdev' 2>/dev/null || { echo "python-evdev no importable en la TV"; exit 1; }
[ -d /dev/input ] || { echo "/dev/input ausente"; exit 1; }
rm -rf /home/root/.mm-new && mkdir -p /home/root/.mm-new
cd /home/root/.mm-new
wget -q "$BASE/magic_mapper.py" -O magic_mapper.py
wget -q "$BASE/magic_mapper_config.json" -O magic_mapper_config.json.dist
wget -q "$BASE/start_magic_mapper" -O start_magic_mapper
[ -s magic_mapper.py ] && [ -s magic_mapper_config.json.dist ] && [ -s start_magic_mapper ]
python3 -c "import ast; ast.parse(open('/home/root/.mm-new/magic_mapper.py').read())"
# start_magic_mapper es SHELL: validar con el interprete que declara.
SHBIN=$(head -1 start_magic_mapper | tr -d '\r' | sed 's/^#!//')
[ -x "$SHBIN" ] || { echo "interprete $SHBIN no existe en la TV"; exit 1; }
"$SHBIN" -n start_magic_mapper || { echo "start_magic_mapper no parsea con $SHBIN"; exit 1; }
# Mover el startup al fs de destino ANTES del deploy (rename atomico luego).
mv /home/root/.mm-new/start_magic_mapper /var/lib/webosbrew/init.d/.start_magic_mapper.staged
REMOTE_EOF
ssh "$USER@$TV" "cat > /home/root/.mm-new/magic_mapper_config.json" < "$CFG"
rm -f "$CFG"
ssh "$USER@$TV" "python3 -m json.tool /home/root/.mm-new/magic_mapper_config.json >/dev/null"

# 2) BACKUP -> STOP -> REPLACE -> START -> VERIFY, con rollback automatico ante
#    CUALQUIER fallo posterior al backup (el restore para el servicio primero).
ssh "$USER@$TV" sh -s <<'REMOTE_EOF'
set -u
TS=$(date +%Y%m%d-%H%M%S)
BK=/home/root/mm-backup-$TS
FILES="/home/root/magic_mapper.py /home/root/magic_mapper_config.json /home/root/magic_mapper_config.json.dist /var/lib/webosbrew/init.d/start_magic_mapper"
mkdir -p "$BK" || exit 1
for f in $FILES; do
  if [ -e "$f" ]; then cp -a "$f" "$BK/" || { echo "backup fallo en $f"; exit 1; }; fi
done
# Script de rollback REAL (sin interpolacion peligrosa: rutas fijas + $BK propio).
cat > /home/root/mm-rollback-$TS.sh <<RB
#!/bin/sh
BK="$BK"
/var/lib/webosbrew/init.d/start_magic_mapper stop 2>/dev/null || true
for f in /home/root/magic_mapper.py /home/root/magic_mapper_config.json /home/root/magic_mapper_config.json.dist /var/lib/webosbrew/init.d/start_magic_mapper; do
  rm -f "\$f"
done
for b in "\$BK"/*; do
  [ -e "\$b" ] || continue
  case "\$b" in
    */start_magic_mapper) cp -a "\$b" /var/lib/webosbrew/init.d/start_magic_mapper ;;
    *) cp -a "\$b" "/home/root/\$(basename "\$b")" ;;
  esac
done
[ -x /var/lib/webosbrew/init.d/start_magic_mapper ] && /var/lib/webosbrew/init.d/start_magic_mapper start || true
RB
chmod +x /home/root/mm-rollback-$TS.sh
rollback() { echo "FALLO - ROLLBACK AUTOMATICO"; sh /home/root/mm-rollback-$TS.sh; exit 1; }

/var/lib/webosbrew/init.d/start_magic_mapper stop 2>/dev/null || true
mv /home/root/.mm-new/magic_mapper.py /home/root/magic_mapper.py || rollback
mv /home/root/.mm-new/magic_mapper_config.json /home/root/magic_mapper_config.json || rollback
mv /home/root/.mm-new/magic_mapper_config.json.dist /home/root/magic_mapper_config.json.dist || rollback
mv /var/lib/webosbrew/init.d/.start_magic_mapper.staged /var/lib/webosbrew/init.d/start_magic_mapper || rollback
chmod +x /var/lib/webosbrew/init.d/start_magic_mapper || rollback
rm -rf /home/root/.mm-new
/var/lib/webosbrew/init.d/start_magic_mapper start || rollback
sleep 2
pgrep -f magic_mapper.py >/dev/null 2>&1 || rollback
echo "magic_mapper: DESPLEGADO Y PROCESO VIVO"
echo "Backup: $BK | Rollback manual: sh /home/root/mm-rollback-$TS.sh"
REMOTE_EOF
