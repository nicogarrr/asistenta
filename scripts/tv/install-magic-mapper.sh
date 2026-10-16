#!/bin/sh
# install-magic-mapper.sh - despliega magic_mapper v1.1.0. R8:
# - TRANSPORTE TELNET por defecto: la tele solo abre telnet 23 con root sin
#   contrasena (banner "~ #"); --transport ssh queda como opcion. El driver
#   (scripts/tv/telnet-sh.py) propaga el exit code remoto con centinela y
#   nunca imprime lo que sube en modo put (puede ser el secreto).
# - TOKEN OBLIGATORIO (TV_BUTTON_TOKEN o --token-file; nunca como argumento
#   posicional): termina en el archivo PRIVADO /home/root/.tv-button-curl.conf
#   (0600) - nunca por CLI, ni en la config JSON, ni en logs, NI EN CLARO
#   POR TELNET: con --transport telnet la tele lo descarga ella misma por TLS
#   de un servidor one-shot del PC (scripts/tv/tv-token-server.py) contra un
#   certificado efimero autofirmado fijado con --cacert (SAN=IP del laptop;
#   la parte publica si cruza por telnet, la clave privada jamas sale del PC).
#   Sin token el script ABORTA: no se despliega un boton abierto.
# - Hash sha256 FIJADO de los 3 ficheros upstream v1.1.0 verificado EN LA
#   TELE con python3 (sha256sum no esta confirmado en la tele); descarga con
#   curl (confirmado en /bin/curl).
# - Parche determinista (templates/patch-magic-mapper.py) tras verificar el
#   hash: curl sin -v (no vuelca Authorization a stderr/log), log sin argv,
#   y soporte token_file via `curl --config`.
# - Backup ampliado a /home/root/.tv-button-curl.conf y listados forenses de
#   init.d y /dev/input; NO toca 50-tvweb ni ningun otro init.d ajeno.
# R7 (se mantiene): rollback generado desde templates/mapper-rollback.sh
# (test mock local); rollback verificado ANTES de mutar; stop del servicio
# viejo confirmado no-vivo antes del rename; --button validado contra la
# lista v1.1.0 (fuente: magic_mapper.py BUTTONS; rakuten = codigo 1044);
# staging en el fs propio de cada destino; pgrep TRI-ESTADO (0=vivo,
# 1=muerto, otro=aborta); backup con MANIFEST.
# Uso: sh install-magic-mapper.sh <ip-tv> <ip-laptop> --button <nombre>
#      [--transport telnet|ssh] [--token-file <path>] [--user <usuario-ssh>]
set -eu
TV="${1:?uso: sh install-magic-mapper.sh <ip-tv> <ip-laptop> --button <nombre> [--transport telnet|ssh] [--token-file p] [--user u]}"
LAPTOP="${2:?falta la IP LAN del laptop (asistenta)}"
shift 2
BTN=""
TRANSPORT="telnet"
TOKEN_FILE=""
USER="root"
while [ $# -gt 0 ]; do
  case "$1" in
    --button) BTN="${2:?--button sin valor}"; shift 2;;
    --transport) TRANSPORT="${2:?--transport sin valor}"; shift 2;;
    --token-file) TOKEN_FILE="${2:?--token-file sin valor}"; shift 2;;
    --user) USER="${2:?--user sin valor}"; shift 2;;
    *) echo "argumento desconocido: $1"; exit 2;;
  esac
done
[ -n "$BTN" ] || { echo "falta --button <nombre> (decision explicita del operador)"; exit 2; }
case "$TRANSPORT" in telnet|ssh) : ;; *) echo "transport invalido: $TRANSPORT"; exit 2;; esac
KNOWN=" red green yellow blue ch_up ch_down vol_up vol_down play pause stop record rewind fastforward 1 2 3 4 5 6 7 8 9 0 prime sling netflix disney lg_channels rakuten alexa google guide voice channels channels_alt search search_alt exit sap tv info home "
case "$KNOWN" in *" $BTN "*) : ;; *) echo "boton invalido o reservado: '$BTN' (lista v1.1.0; magic_mapper_settings esta reservado)"; exit 2;; esac
VERSION="v1.1.0"
BASE="https://raw.githubusercontent.com/andrewfraley/magic_mapper/$VERSION"
SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
# sha256 fijados del upstream andrewfraley/magic_mapper tag v1.1.0 (verificados
# contra raw.githubusercontent.com el 2026-10-16). templates/patch-magic-mapper.py
# lleva la misma constante para magic_mapper.py; test-tv-token-patch-mock.sh
# exige que coincidan.
SHA_MM="36839ef0468c094ea64e0c3fc8811c701fb8f7961ff7f6b905a41c39c58232f0"
SHA_CFG="da8813752ca344c761953ab7289301cfcf5e5cf47a6f42a8972ba5ac965cf5b7"
SHA_START="dd67ad4e73e265eef34cea6cb79de2d1c60f55b95ba264971a27fe8194571a8b"
TOKEN_CONF_REMOTE="/home/root/.tv-button-curl.conf"

O1=$(echo "$LAPTOP" | cut -d. -f1); O2=$(echo "$LAPTOP" | cut -d. -f2)
O3=$(echo "$LAPTOP" | cut -d. -f3); O4=$(echo "$LAPTOP" | cut -d. -f4)
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

# --- Token (obligatorio): entorno o archivo local; NUNCA argumento posicional.
TOKEN="${TV_BUTTON_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -n "$TOKEN_FILE" ]; then
  [ -r "$TOKEN_FILE" ] || { echo "--token-file no legible: $TOKEN_FILE"; exit 2; }
  TOKEN=$(head -n 1 "$TOKEN_FILE" | tr -d '\r\n')
fi
[ -n "$TOKEN" ] || { echo "sin token NO se instala: exporta TV_BUTTON_TOKEN o pasa --token-file"; echo "(mismo valor que tv:buttonToken en el vault del PC; el listener lo exige)"; exit 2; }
case "$TOKEN" in *\"*|*\\*) echo "token con comillas o backslash no soportado (curl --config)"; exit 2;; esac

# --- Transporte: prerrequisitos locales.
if [ "$TRANSPORT" = "telnet" ]; then
  command -v python3 >/dev/null || { echo "python3 local no existe (lo necesita el driver telnet)"; exit 1; }
  [ -f "$SCRIPT_DIR/telnet-sh.py" ] || { echo "falta $SCRIPT_DIR/telnet-sh.py"; exit 1; }
  [ -f "$SCRIPT_DIR/tv-token-server.py" ] || { echo "falta $SCRIPT_DIR/tv-token-server.py"; exit 1; }
  command -v openssl >/dev/null || { echo "openssl local no existe (canal TLS del token); alternativa: --transport ssh"; exit 1; }
else
  command -v ssh >/dev/null || { echo "ssh local no existe"; exit 1; }
fi

# remote_sh [args...] < script : ejecuta `sh -s -- args` en la tele.
remote_sh() {
  if [ "$TRANSPORT" = "telnet" ]; then
    python3 "$SCRIPT_DIR/telnet-sh.py" sh "$TV" -- "$@"
  else
    ssh "$USER@$TV" sh -s "$@"
  fi
}
# remote_put <local> <remoto> <modo> : escribe un archivo en la tele.
# El contenido viaja por el canal, nunca por argv.
remote_put() {
  if [ "$TRANSPORT" = "telnet" ]; then
    python3 "$SCRIPT_DIR/telnet-sh.py" put "$TV" "$1" "$2" "$3"
  else
    ssh "$USER@$TV" "cat > '$2'" < "$1" && ssh "$USER@$TV" "chmod '$3' '$2'"
  fi
}

curl -fsS -m 3 "http://$LAPTOP:8765/tv/button-health" >/dev/null 2>&1 \
  || { echo "listener :8765/tv/button-health NO responde en $LAPTOP - despliega primero la PR del listener"; exit 2; }

CFG="/tmp/mm-config-$$.json"
TOKCFG="/tmp/mm-token-$$.conf"
SRV=""
CERTD=""
trap 'rm -f "$CFG" "$TOKCFG"; [ -z "$SRV" ] || kill "$SRV" 2>/dev/null || true; [ -z "$CERTD" ] || rm -rf "$CERTD"' EXIT
sed -e "s|__ASISTENTA_URL__|http://$LAPTOP:8765/tv/button|" -e "s|\"__BUTTON__\"|\"$BTN\"|" \
  "$SCRIPT_DIR/../../config/tv/magic_mapper_config.json" > "$CFG"
python3 -m json.tool "$CFG" >/dev/null || { echo "config no es JSON valido"; exit 1; }
python3 -c "import json;d=json.load(open('$CFG'));assert '$BTN' in d" || exit 1
python3 -c "import json;i=json.load(open('$CFG'))['$BTN']['inputs'];assert i.get('token_file')=='$TOKEN_CONF_REMOTE', i" \
  || { echo "config sin token_file - el mapeo quedaria SIN autenticacion"; exit 1; }
# Archivo curl --config con la cabecera; nace 0600 y 0600 llega a la tele.
( umask 077; printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" > "$TOKCFG" )

# 1) Parcheador a la tele + preflight + descarga verificada + parche.
remote_put "$SCRIPT_DIR/templates/patch-magic-mapper.py" /home/root/.mm-patch.py 644
remote_sh "$BASE" "$SHA_MM" "$SHA_CFG" "$SHA_START" <<'REMOTE_EOF'
set -eu
BASE="$1"; EXP_MM="$2"; EXP_CFG="$3"; EXP_START="$4"
mkdir -p /var/lib/webosbrew/init.d
command -v python3 >/dev/null || { echo "python3 no existe en la TV"; exit 1; }
command -v curl >/dev/null || { echo "curl no existe en la TV (descarga y boton lo necesitan)"; exit 1; }
command -v pgrep >/dev/null || { echo "pgrep no existe en la TV (lo exigen deploy y rollback)"; exit 1; }
[ -d /dev/input ] || { echo "/dev/input ausente"; exit 1; }
echo "init.d actual (NO se toca nada ajeno):"; ls /var/lib/webosbrew/init.d/
rm -rf /home/root/.mm-new && mkdir -p /home/root/.mm-new
cd /home/root/.mm-new
curl -fsSL -m 30 "$BASE/magic_mapper.py" -o magic_mapper.py
curl -fsSL -m 30 "$BASE/magic_mapper_config.json" -o magic_mapper_config.json.dist
curl -fsSL -m 30 "$BASE/start_magic_mapper" -o start_magic_mapper
[ -s magic_mapper.py ] || { echo "magic_mapper.py vacio/ausente"; exit 1; }
[ -s magic_mapper_config.json.dist ] || { echo "config dist vacio/ausente"; exit 1; }
[ -s start_magic_mapper ] || { echo "start_magic_mapper vacio/ausente"; exit 1; }
# Hash FIJADO verificado en la tele con python3 (sha256sum no confirmado).
check_sha() {
  actual=$(python3 -c "import hashlib;print(hashlib.sha256(open('$1','rb').read()).hexdigest())")
  [ "$actual" = "$2" ] || { echo "sha256 NO cuadra en $1: $actual != $2 - upstream cambio, aborto"; exit 1; }
}
check_sha magic_mapper.py "$EXP_MM"
check_sha magic_mapper_config.json.dist "$EXP_CFG"
check_sha start_magic_mapper "$EXP_START"
# Parche determinista: verifica hash otra vez, anclas exactas, reparseo ast.
python3 /home/root/.mm-patch.py /home/root/.mm-new/magic_mapper.py
python3 -c "import ast; ast.parse(open('/home/root/.mm-new/magic_mapper.py').read())"
SHBIN=$(head -1 start_magic_mapper | tr -d '\r' | sed 's/^#!//')
[ -x "$SHBIN" ] || { echo "interprete $SHBIN no existe en la TV"; exit 1; }
"$SHBIN" -n start_magic_mapper || { echo "start_magic_mapper no parsea con $SHBIN"; exit 1; }
mv /home/root/.mm-new/start_magic_mapper /var/lib/webosbrew/init.d/.start_magic_mapper.staged
REMOTE_EOF

# 2) Config (sin secretos) y token (archivo privado) a staging en la tele.
remote_put "$CFG" /home/root/.mm-new/magic_mapper_config.json 644
remote_sh <<'REMOTE_EOF'
set -eu
python3 -m json.tool /home/root/.mm-new/magic_mapper_config.json >/dev/null
REMOTE_EOF
if [ "$TRANSPORT" = "telnet" ]; then
  # La tele hace PULL del token por TLS; por telnet solo cruza el cert publico.
  CERTD=$(mktemp -d)
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$CERTD/key.pem" -out "$CERTD/cert.pem" -days 1 \
    -subj "/CN=tv-button" -addext "subjectAltName=IP:$LAPTOP" >/dev/null 2>&1 \
    || { echo "openssl no pudo crear el cert efimero (SAN IP:$LAPTOP)"; exit 1; }
  chmod 600 "$CERTD/key.pem"
  python3 "$SCRIPT_DIR/tv-token-server.py" --bind "$LAPTOP" --file "$TOKCFG" \
    --cert "$CERTD/cert.pem" --key "$CERTD/key.pem" --port-file "$CERTD/port" &
  SRV=$!
  i=0
  while [ ! -s "$CERTD/port" ]; do
    sleep 0.1; i=$((i+1))
    [ "$i" -lt 100 ] || { echo "servidor one-shot del token no arranco"; exit 1; }
  done
  TOKPORT=$(cat "$CERTD/port")
  remote_put "$CERTD/cert.pem" /home/root/.mm-token-ca.pem 644
  if ! remote_sh "$LAPTOP" "$TOKPORT" <<'REMOTE_EOF'
set -eu
curl -fsSL -m 15 --cacert /home/root/.mm-token-ca.pem "https://$1:$2/tv-button-token" -o /home/root/.mm-new/tv-button-curl.conf
rm -f /home/root/.mm-token-ca.pem
chmod 600 /home/root/.mm-new/tv-button-curl.conf
REMOTE_EOF
  then
    echo "la tele no pudo descargar el token por TLS - aborto ANTES de mutar"
    exit 1
  fi
  wait "$SRV" 2>/dev/null || { echo "el servidor one-shot no confirmo la entrega del token"; exit 1; }
  SRV=""
  rm -rf "$CERTD"; CERTD=""
else
  # Por ssh el canal ya va cifrado.
  remote_put "$TOKCFG" /home/root/.mm-new/tv-button-curl.conf 600
fi
rm -f "$CFG" "$TOKCFG"

# 3) Backup + rollback + swap.
remote_put "$SCRIPT_DIR/templates/mapper-rollback.sh" /home/root/.mm-rollback.tmpl 644
remote_sh <<'REMOTE_EOF'
set -eu
TS=$(date +%Y%m%d-%H%M%S)
BK=/home/root/mm-backup-$TS
FILES="/home/root/magic_mapper.py /home/root/magic_mapper_config.json /home/root/magic_mapper_config.json.dist /home/root/.tv-button-curl.conf /var/lib/webosbrew/init.d/start_magic_mapper"
mkdir -p "$BK"
# BACKUP_BLOCK_START (cubierto por test-tv-rollback-mock.sh, caso "cp del instalador roto")
for f in $FILES; do
  if [ -e "$f" ]; then
    cp -a "$f" "$BK/" || { echo "backup fallo en $f - aborto ANTES de stop/rename"; exit 1; }
    basename "$f" >> "$BK/.mlist"
  fi
done
# BACKUP_BLOCK_END
# MANIFEST: lo respaldado, o EMPTY si no habia instalacion previa (distingue
# "sin instalacion" de "backup perdido" en el rollback).
if [ -f "$BK/.mlist" ]; then mv "$BK/.mlist" "$BK/MANIFEST"; else echo EMPTY > "$BK/MANIFEST"; fi
# Listados forenses (solo lectura): estado previo de init.d y dispositivos.
ls -la /var/lib/webosbrew/init.d > "$BK/initd.listing" 2>/dev/null || true
ls -la /dev/input > "$BK/dev-input.listing" 2>/dev/null || true
# Rollback REAL generado desde el template testeado (templates/mapper-rollback.sh):
# stop sin ||true, guard no-vivo antes de rm, restore con fallos visibles.
sed "s|__BK__|$BK|g" /home/root/.mm-rollback.tmpl > /home/root/mm-rollback-$TS.sh
chmod +x /home/root/mm-rollback-$TS.sh
[ -x /home/root/mm-rollback-$TS.sh ] || { echo "rollback script NO creado - aborto ANTES de mutar"; exit 1; }
rollback() {
  echo "FALLO - ROLLBACK AUTOMATICO"
  if ! sh /home/root/mm-rollback-$TS.sh; then echo "EL ROLLBACK TAMBIEN FALLO: restaurar a mano desde $BK"; fi
  exit 1
}
# Stop confirmado no-vivo ANTES de mutar (tambien sin init: proceso huerfano).
if [ -x /var/lib/webosbrew/init.d/start_magic_mapper ]; then
  /var/lib/webosbrew/init.d/start_magic_mapper stop 2>/dev/null || true
fi
sleep 1
# pgrep tri-estado: 0=vivo (aborta), 1=muerto (sigue), otro=error (aborta visible)
rc=0; pgrep -f magic_mapper.py >/dev/null 2>&1 || rc=$?
[ "$rc" = "1" ] || { [ "$rc" = "0" ] && echo "un magic_mapper viejo sigue VIVO - aborto ANTES de mutar" || echo "pgrep fallo con exit $rc - no puedo confirmar proceso muerto"; exit 1; }
mv /home/root/.mm-new/magic_mapper.py /home/root/magic_mapper.py || rollback
mv /home/root/.mm-new/magic_mapper_config.json /home/root/magic_mapper_config.json || rollback
mv /home/root/.mm-new/magic_mapper_config.json.dist /home/root/magic_mapper_config.json.dist || rollback
mv /home/root/.mm-new/tv-button-curl.conf /home/root/.tv-button-curl.conf || rollback
[ "$(stat -c %a /home/root/.tv-button-curl.conf 2>/dev/null || echo 000)" = "600" ] \
  || { echo "el token privado no quedo 0600 - rollback"; rollback; }
mv /var/lib/webosbrew/init.d/.start_magic_mapper.staged /var/lib/webosbrew/init.d/start_magic_mapper || rollback
chmod +x /var/lib/webosbrew/init.d/start_magic_mapper || rollback
rm -rf /home/root/.mm-new /home/root/.mm-patch.py
/var/lib/webosbrew/init.d/start_magic_mapper start || rollback
sleep 2
pgrep -f magic_mapper.py >/dev/null 2>&1 || rollback
echo "magic_mapper: DESPLEGADO Y PROCESO VIVO"
echo "Backup: $BK | Rollback manual: sh /home/root/mm-rollback-$TS.sh"
REMOTE_EOF
