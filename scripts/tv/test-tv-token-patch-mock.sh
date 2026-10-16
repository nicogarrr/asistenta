#!/bin/dash
# test-tv-token-patch-mock.sh - parche de magic_mapper, driver telnet y canal
# TLS del token, todo contra fixtures locales (sin red externa ni tele).
set -eu
DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"; [ -z "${SRV:-}" ] || kill "$SRV" 2>/dev/null || true' EXIT
PASS=0
ok() { PASS=$((PASS+1)); echo "ok $PASS - $1"; }
fail() { echo "FALLO - $1" >&2; exit 1; }

# Fixture con las 3 anclas EXACTAS del upstream v1.1.0 (funcion curl()).
fixture() {
cat > "$1" <<'PY'
def curl(inputs):
    url = inputs.get("url")
    method = inputs.get("method", "GET").upper()
    command_string = "curl -vs -X %s" % method
    command = command_string.split()

    headers = inputs.get("headers")
    command.append(url)
    print("Running curl command: %s" % " ".join(command))
PY
}

# 1) parche feliz: sin -v, log sin argv, token_file por --config, parsea
fixture "$T/mm.py"
SHA=$(sha256sum "$T/mm.py" | cut -d' ' -f1)
python3 "$DIR/templates/patch-magic-mapper.py" "$T/mm.py" --expect-sha="$SHA" >/dev/null || fail "1: parche debia aplicar"
grep -q 'curl -vs' "$T/mm.py" && fail "1: -v sigue presente"
grep -q 'token_file' "$T/mm.py" || fail "1: falta soporte token_file"
grep -q '" ".join(command)' "$T/mm.py" && fail "1: el print sigue volcando argv"
grep -q 'Running curl request' "$T/mm.py" || fail "1: falta log redactado"
python3 -c "import ast;ast.parse(open('$T/mm.py').read())" || fail "1: no parsea"
ok "parche: -v fuera, argv fuera del log, token_file via curl --config"

# 2) hash que no cuadra: aborta y NO toca el fichero
fixture "$T/mm2.py"
OUT=$(python3 "$DIR/templates/patch-magic-mapper.py" "$T/mm2.py" --expect-sha=0000 2>&1) && fail "2: hash malo debia abortar"
echo "$OUT" | grep -q 'sha256' || fail "2: abort no visible"
grep -q 'curl -vs' "$T/mm2.py" || fail "2: fichero tocado pese al abort"
ok "parche: hash distinto -> aborta sin escribir (fail-closed)"

# 3) ancla no unica (fichero ya parcheado): aborta visible
OUT=$(python3 "$DIR/templates/patch-magic-mapper.py" "$T/mm.py" --expect-sha="$(sha256sum "$T/mm.py" | cut -d' ' -f1)" 2>&1) && fail "3: re-parche debia abortar"
echo "$OUT" | grep -q 'ancla' || fail "3: abort de ancla no visible"
ok "parche: segunda pasada aborta (cada ancla exactamente una vez)"

# 4) constante fijada sincronizada instalador <-> parcheador
A=$(sed -n 's/^SHA_MM="\(.*\)"/\1/p' "$DIR/install-magic-mapper.sh")
B=$(sed -n 's/^EXPECTED_SHA256 = "\(.*\)"/\1/p' "$DIR/templates/patch-magic-mapper.py")
[ -n "$A" ] && [ "$A" = "$B" ] || fail "4: hash fijado difiere entre instalador y parcheador"
ok "hash fijado: instalador y parcheador comparten la misma constante"

# 5) la plantilla de config lleva token_file y NUNCA la cabecera
grep -q '"token_file": "/home/root/.tv-button-curl.conf"' "$DIR/../../config/tv/magic_mapper_config.json" \
  || fail "5: config sin token_file"
grep -qi 'authorization\|bearer' "$DIR/../../config/tv/magic_mapper_config.json" \
  && fail "5: la config JSON no debe llevar la cabecera"
ok "config: token_file referenciado, cabecera fuera del JSON"

# 6) el instalador exige token, lo escribe 0600 y nunca en claro por telnet
grep -q 'sin token NO se instala' "$DIR/install-magic-mapper.sh" || fail "6: instalador sin guardia de token"
grep -q 'umask 077' "$DIR/install-magic-mapper.sh" || fail "6: el conf del token no nace 0600"
grep -q 'tv-token-server.py' "$DIR/install-magic-mapper.sh" || fail "6: falta el canal TLS one-shot"
grep -q 'base64 -d > .*tv-button-curl' "$DIR/install-magic-mapper.sh" && fail "6: el token no puede cruzar telnet en base64"
grep -q 'import evdev' "$DIR/install-magic-mapper.sh" && fail "6: evdev no es prerequisito de v1.1.0"
ok "instalador: token obligatorio, 0600, TLS one-shot en telnet, sin falso evdev"

# 7) driver telnet sh: salida y exit code remoto propagados (servidor falso)
# Emula telnetd de verdad: el shell va sobre un PTY (line-buffered, eco,
# stty), no sobre el socket crudo, y el cierre del cliente llega como EOT.
cat > "$T/fake-tv.py" <<'PY'
import os, pty, select, socket, subprocess, sys
srv = socket.socket()
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", 0))
srv.listen(1)
sys.stdout.write(str(srv.getsockname()[1]) + "\n"); sys.stdout.flush()
conn, _ = srv.accept()
conn.sendall(b"~ # ")
master, slave = pty.openpty()
p = subprocess.Popen(["sh"], stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
conn_open, master_open, eot_sent = True, True, False
while master_open:
    fds = [master] + ([conn] if conn_open else [])
    r, _, _ = select.select(fds, [], [], 2)
    if not r:
        break
    for fd in r:
        if fd is conn:
            data = conn.recv(4096)
            if data:
                os.write(master, data)
            else:
                conn_open = False
                if not eot_sent:
                    eot_sent = True
                    os.write(master, b"\x04")
        else:
            try:
                data = os.read(master, 4096)
            except OSError:
                data = b""
            if data:
                conn.sendall(data)
            else:
                master_open = False
if p.poll() is None:
    p.terminate()  # el shell externo (interactivo) IGNORA SIGTERM: kill seguro
    try:
        p.wait(timeout=2)
    except subprocess.TimeoutExpired:
        p.kill()
p.wait()
conn.close()
PY
python3 "$T/fake-tv.py" > "$T/port" & SRV=$!
i=0; while [ ! -s "$T/port" ]; do sleep 0.1; i=$((i+1)); [ "$i" -lt 50 ] || fail "7: servidor falso no arranco"; done
PORT=$(cat "$T/port")
RC=0
OUT=$(printf 'echo hola-tele\n(exit 7)\n' | python3 "$DIR/telnet-sh.py" sh 127.0.0.1 --port "$PORT" --timeout 5 --) || RC=$?
wait "$SRV" 2>/dev/null || true; SRV=""; : > "$T/port"
[ "$RC" = "7" ] || fail "7: exit remoto no propagado (rc=$RC)"
echo "$OUT" | grep -q 'hola-tele' || fail "7: salida remota no llego"
ok "telnet sh: salida y exit code remoto propagados (rc=7)"

# 8) driver telnet put: escribe con modo y NO imprime el secreto
printf 'header = "Authorization: Bearer SECRETO-DE-PRUEBA"\n' > "$T/tok.conf"
python3 "$T/fake-tv.py" > "$T/port" & SRV=$!
i=0; while [ ! -s "$T/port" ]; do sleep 0.1; i=$((i+1)); [ "$i" -lt 50 ] || fail "8: servidor falso no arranco"; done
PORT=$(cat "$T/port")
OUT=$(python3 "$DIR/telnet-sh.py" put 127.0.0.1 "$T/tok.conf" "$T/dest.conf" 600 --port "$PORT" --timeout 5) || fail "8: put debia funcionar"
wait "$SRV" 2>/dev/null || true; SRV=""; : > "$T/port"
[ "$(cat "$T/dest.conf")" = 'header = "Authorization: Bearer SECRETO-DE-PRUEBA"' ] || fail "8: contenido distinto"
[ "$(stat -c %a "$T/dest.conf")" = "600" ] || fail "8: modo distinto de 600"
echo "$OUT" | grep -q 'SECRETO-DE-PRUEBA' && fail "8: el secreto se imprimio"
echo "$OUT" | grep -q 'aGVhZGVy' && fail "8: el base64 del secreto se imprimio"
ok "telnet put: archivo 0600 identico, secreto jamas impreso"

# 9) sin centinela (conexion muerta a mitad): fallo de transporte, no exit 0
: > "$T/port"
cat > "$T/fake-tv-mudo.py" <<'PY'
import socket, sys, time
srv = socket.socket()
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", 0))
srv.listen(1)
sys.stdout.write(str(srv.getsockname()[1]) + "\n"); sys.stdout.flush()
conn, _ = srv.accept()
conn.sendall(b"~ # ")
conn.recv(65536)
conn.close()  # muere sin ejecutar nada: no hay centinela
PY
python3 "$T/fake-tv-mudo.py" > "$T/port" & SRV=$!
i=0; while [ ! -s "$T/port" ]; do sleep 0.1; i=$((i+1)); [ "$i" -lt 50 ] || fail "9: servidor falso no arranco"; done
PORT=$(cat "$T/port")
RC=0
printf 'echo no-importa\n' | python3 "$DIR/telnet-sh.py" sh 127.0.0.1 --port "$PORT" --timeout 5 -- >/dev/null 2>&1 || RC=$?
wait "$SRV" 2>/dev/null || true; SRV=""
[ "$RC" = "3" ] || fail "9: sin centinela debia ser fallo de transporte (rc=$RC)"
ok "telnet sh: sin centinela -> fallo de transporte visible, nunca exit 0"

# 10) servidor one-shot del token: sirve UNA vez por TLS con cert fijado
command -v openssl >/dev/null || { echo "skip 10-11: sin openssl"; echo "PASS $PASS/9"; exit 0; }
CERTD="$T/cert"; mkdir -p "$CERTD"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$CERTD/key.pem" -out "$CERTD/cert.pem" \
  -days 1 -subj "/CN=tv-button" -addext "subjectAltName=IP:127.0.0.1" >/dev/null 2>&1 || fail "10: cert"
printf 'header = "Authorization: Bearer SECRETO-TLS"\n' > "$T/tls.conf"
python3 "$DIR/tv-token-server.py" --bind 127.0.0.1 --file "$T/tls.conf" \
  --cert "$CERTD/cert.pem" --key "$CERTD/key.pem" --port-file "$CERTD/port" --max-age 15 & SRV=$!
i=0; while [ ! -s "$CERTD/port" ]; do sleep 0.1; i=$((i+1)); [ "$i" -lt 50 ] || fail "10: one-shot no arranco"; done
PORT=$(cat "$CERTD/port")
curl -fsSL --cacert "$CERTD/cert.pem" "https://127.0.0.1:$PORT/tv-button-token" -o "$T/tls-out.conf" || fail "10: curl TLS fallo"
[ "$(cat "$T/tls-out.conf")" = 'header = "Authorization: Bearer SECRETO-TLS"' ] || fail "10: contenido distinto"
wait "$SRV" || fail "10: el one-shot debia morir con exit 0 tras servir"
SRV=""
ok "one-shot TLS: entrega verificada por cert fijado y muere tras servir"

# 11) one-shot: ruta equivocada es 404 y sin cert el TLS no valida
python3 "$DIR/tv-token-server.py" --bind 127.0.0.1 --file "$T/tls.conf" \
  --cert "$CERTD/cert.pem" --key "$CERTD/key.pem" --port-file "$CERTD/port2" --max-age 15 & SRV=$!
i=0; while [ ! -s "$CERTD/port2" ]; do sleep 0.1; i=$((i+1)); [ "$i" -lt 50 ] || fail "11: one-shot no arranco"; done
PORT=$(cat "$CERTD/port2")
curl -fsS --cacert "$CERTD/cert.pem" "https://127.0.0.1:$PORT/otra-cosa" >/dev/null 2>&1 && fail "11: ruta ajena debia 404"
curl -fsS "https://127.0.0.1:$PORT/tv-button-token" -o /dev/null 2>/dev/null && fail "11: sin --cacert no debia validar"
# El intento sin cert no consumio la unica entrega: con --cacert sigue sirviendo.
curl -fsSL --cacert "$CERTD/cert.pem" "https://127.0.0.1:$PORT/tv-button-token" -o "$T/tls-out2.conf" || fail "11: la entrega legitima debia seguir disponible"
grep -q 'SECRETO-TLS' "$T/tls-out2.conf" || fail "11: contenido distinto"
wait "$SRV" || fail "11: el one-shot debia morir con exit 0 tras servir"
SRV=""
ok "one-shot TLS: ruta ajena 404, sin cert no valida, entrega legitima intacta"

echo "PASS $PASS/11"
