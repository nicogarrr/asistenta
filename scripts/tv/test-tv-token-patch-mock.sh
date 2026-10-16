#!/bin/dash
# test-tv-token-patch-mock.sh - parche de magic_mapper, driver telnet y canal
# TLS del token, todo contra fixtures locales (sin red externa ni tele).
set -eu
DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"; [ -z "${SRV:-}" ] || kill "$SRV" 2>/dev/null || true; [ -z "${STALL:-}" ] || kill "$STALL" 2>/dev/null || true' EXIT
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

# 1) parche feliz: sin -v, log sin argv, firma HMAC por pulsacion, parsea
fixture "$T/mm.py"
SHA=$(sha256sum "$T/mm.py" | cut -d' ' -f1)
python3 "$DIR/templates/patch-magic-mapper.py" "$T/mm.py" --expect-sha="$SHA" >/dev/null || fail "1: parche debia aplicar"
grep -q 'curl -vs' "$T/mm.py" && fail "1: -v sigue presente"
grep -q 'token_file' "$T/mm.py" || fail "1: falta soporte token_file"
grep -q 'X-TV-Sig' "$T/mm.py" || fail "1: falta la firma HMAC (X-TV-Sig)"
grep -q 'X-TV-Nonce' "$T/mm.py" || fail "1: falta el nonce por pulsacion"
grep -q 'hmac' "$T/mm.py" || fail "1: falta hmac"
grep -q -- '--config' "$T/mm.py" && fail "1: ya no vale curl --config con el Bearer"
grep -qi 'authorization\|bearer' "$T/mm.py" && fail "1: no debe quedar Authorization Bearer"
grep -q '" ".join(command)' "$T/mm.py" && fail "1: el print sigue volcando argv"
grep -q 'Running curl request' "$T/mm.py" || fail "1: falta log redactado"
python3 -c "import ast;ast.parse(open('$T/mm.py').read())" || fail "1: no parsea"
# El fixture parcheado firma de verdad: el secreto NO aparece en argv y la
# cabecera X-TV-Sig es el HMAC esperado de "ts.nonce.GET./tv/button".
printf 'SECRETO-FIXTURE\n' > "$T/tok"
python3 - "$T/mm.py" "$T/tok" <<'PY' || fail "1: la firma generada no es el HMAC esperado"
import hashlib, hmac, sys
src = open(sys.argv[1]).read()
# Instrumentacion del FIXTURE: captura el comando en vez de solo imprimir.
anchor = 'print("Running curl request: %s %s" % (method, url))'
assert src.count(anchor) == 1
src = src.replace(anchor, "captured.extend(command)")
captured = []
ns = {"captured": captured}
exec(src, ns)
ns["curl"]({"url": "http://192.168.1.100:8765/tv/button", "token_file": sys.argv[2]})
assert "SECRETO-FIXTURE" not in " ".join(captured), "el secreto acabo en argv"
hdrs = [captured[j + 1] for j, v in enumerate(captured) if v == "-H"]
ts = hdrs[0].split(": ", 1)[1]; nonce = hdrs[1].split(": ", 1)[1]; sig = hdrs[2].split(": ", 1)[1]
assert hdrs[0].startswith("X-TV-Ts: ") and hdrs[1].startswith("X-TV-Nonce: ") and hdrs[2].startswith("X-TV-Sig: "), hdrs
expect = hmac.new(b"SECRETO-FIXTURE", ("%s.%s.GET./tv/button" % (ts, nonce)).encode(), hashlib.sha256).hexdigest()
assert sig == expect, (sig, expect)
PY
ok "parche: -v fuera, argv fuera del log, HMAC por pulsacion (sin Bearer)"

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
grep -q '"token_file": "/home/root/.tv-button-token"' "$DIR/../../config/tv/magic_mapper_config.json" \
  || fail "5: config sin token_file"
grep -qi 'authorization\|bearer' "$DIR/../../config/tv/magic_mapper_config.json" \
  && fail "5: la config JSON no debe llevar la cabecera"
ok "config: token_file referenciado, cabecera fuera del JSON"

# 6) el instalador exige token, lo sirve en crudo por TLS one-shot con
#    allow-ip + nonce, y los temporales viven en un mktemp privado
grep -q 'sin token NO se instala' "$DIR/install-magic-mapper.sh" || fail "6: instalador sin guardia de token"
grep -q 'umask 077' "$DIR/install-magic-mapper.sh" || fail "6: falta umask 077 (token y/o pull remoto)"
grep -q 'tv-token-server.py' "$DIR/install-magic-mapper.sh" || fail "6: falta el canal TLS one-shot"
grep -q -- '--allow-ip "\$TV"' "$DIR/install-magic-mapper.sh" || fail "6: el one-shot debe servir SOLO a la IP de la tele"
grep -q -- '--nonce "\$NONCE"' "$DIR/install-magic-mapper.sh" || fail "6: falta la ruta con nonce de un solo uso"
grep -q 'mktemp -d' "$DIR/install-magic-mapper.sh" || fail "6: temporales deben vivir en un mktemp -d privado"
grep -q '/tmp/mm-token-\$\$' "$DIR/install-magic-mapper.sh" && fail "6: ruta predecible en /tmp (symlink plantable)"
grep -qi 'authorization: bearer' "$DIR/install-magic-mapper.sh" && fail "6: el token ya no viaja como Bearer en un curl --config"
grep -q 'import evdev' "$DIR/install-magic-mapper.sh" && fail "6: evdev no es prerequisito de v1.1.0"
ok "instalador: token obligatorio y validado, mktemp privado, TLS one-shot con allow-ip+nonce"

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
printf 'SECRETO-DE-PRUEBA\n' > "$T/tok.conf"
python3 "$T/fake-tv.py" > "$T/port" & SRV=$!
i=0; while [ ! -s "$T/port" ]; do sleep 0.1; i=$((i+1)); [ "$i" -lt 50 ] || fail "8: servidor falso no arranco"; done
PORT=$(cat "$T/port")
OUT=$(python3 "$DIR/telnet-sh.py" put 127.0.0.1 "$T/tok.conf" "$T/dest.conf" 600 --port "$PORT" --timeout 5) || fail "8: put debia funcionar"
wait "$SRV" 2>/dev/null || true; SRV=""; : > "$T/port"
[ "$(cat "$T/dest.conf")" = 'SECRETO-DE-PRUEBA' ] || fail "8: contenido distinto"
[ "$(stat -c %a "$T/dest.conf")" = "600" ] || fail "8: modo distinto de 600"
echo "$OUT" | grep -q 'SECRETO-DE-PRUEBA' && fail "8: el secreto se imprimio"
echo "$OUT" | grep -q 'U0VDUkVUTw' && fail "8: el base64 del secreto se imprimio"
ok "telnet put: archivo 0600 identico, secreto jamas impreso"

# 9) put con base64 ROTO en la tele: el fallo PROPAGA y el destino no se crea
# Canario del auditor: sin set -e el centinela daba 0 con el destino vacio.
mkdir -p "$T/badbin"
printf '#!/bin/sh\necho "base64 roto" >&2\nexit 1\n' > "$T/badbin/base64"; chmod +x "$T/badbin/base64"
PATH="$T/badbin:/usr/bin:/bin" python3 "$T/fake-tv.py" > "$T/port" & SRV=$!
i=0; while [ ! -s "$T/port" ]; do sleep 0.1; i=$((i+1)); [ "$i" -lt 50 ] || fail "9: servidor falso no arranco"; done
PORT=$(cat "$T/port")
RC=0
OUT=$(python3 "$DIR/telnet-sh.py" put 127.0.0.1 "$T/tok.conf" "$T/dest2.conf" 600 --port "$PORT" --timeout 5) || RC=$?
wait "$SRV" 2>/dev/null || true; SRV=""; : > "$T/port"
[ "$RC" != "0" ] || fail "9: base64 roto debia propagar fallo"
[ ! -e "$T/dest2.conf" ] || fail "9: el destino no debe existir tras un decode roto"
echo "$OUT" | grep -q 'U0VDUkVUTw' && fail "9: el base64 del secreto se imprimio"
ok "telnet put: base64 roto -> exit != 0, destino intacto (set -e + validacion)"

# 10) sin centinela (conexion muerta a mitad): fallo de transporte, no exit 0
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
i=0; while [ ! -s "$T/port" ]; do sleep 0.1; i=$((i+1)); [ "$i" -lt 50 ] || fail "10: servidor falso no arranco"; done
PORT=$(cat "$T/port")
RC=0
printf 'echo no-importa\n' | python3 "$DIR/telnet-sh.py" sh 127.0.0.1 --port "$PORT" --timeout 5 -- >/dev/null 2>&1 || RC=$?
wait "$SRV" 2>/dev/null || true; SRV=""
[ "$RC" = "3" ] || fail "10: sin centinela debia ser fallo de transporte (rc=$RC)"
ok "telnet sh: sin centinela -> fallo de transporte visible, nunca exit 0"

command -v openssl >/dev/null || { echo "skip 11-16: sin openssl"; echo "PASS $PASS/10"; exit 0; }
CERTD="$T/cert"; mkdir -p "$CERTD"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$CERTD/key.pem" -out "$CERTD/cert.pem" \
  -days 1 -subj "/CN=tv-button" -addext "subjectAltName=IP:127.0.0.1" >/dev/null 2>&1 || fail "11: cert"
printf 'SECRETO-TLS\n' > "$T/tls.conf"
NONCE=deadbeefcafe1234

wait_port() { # $1=fichero de puerto, $2=test
  i=0; while [ ! -s "$1" ]; do sleep 0.1; i=$((i+1)); [ "$i" -lt 50 ] || fail "$2: one-shot no arranco"; done
  cat "$1"
}

# 11) servidor one-shot del token: sirve UNA vez por TLS con cert fijado,
#     SOLO en la ruta con nonce y SOLO a la IP permitida
python3 "$DIR/tv-token-server.py" --bind 127.0.0.1 --allow-ip 127.0.0.1 --nonce "$NONCE" \
  --file "$T/tls.conf" --cert "$CERTD/cert.pem" --key "$CERTD/key.pem" \
  --port-file "$CERTD/port" --max-age 15 & SRV=$!
PORT=$(wait_port "$CERTD/port" 11)
curl -fsSL --cacert "$CERTD/cert.pem" "https://127.0.0.1:$PORT/tv-button-token/$NONCE" -o "$T/tls-out.conf" || fail "11: curl TLS fallo"
[ "$(cat "$T/tls-out.conf")" = 'SECRETO-TLS' ] || fail "11: contenido distinto"
wait "$SRV" || fail "11: el one-shot debia morir con exit 0 tras servir"
SRV=""
ok "one-shot TLS: entrega verificada por cert fijado y muere tras servir"

# 12) one-shot: ruta sin nonce es 404 y sin cert el TLS no valida
python3 "$DIR/tv-token-server.py" --bind 127.0.0.1 --allow-ip 127.0.0.1 --nonce "$NONCE" \
  --file "$T/tls.conf" --cert "$CERTD/cert.pem" --key "$CERTD/key.pem" \
  --port-file "$CERTD/port2" --max-age 15 & SRV=$!
PORT=$(wait_port "$CERTD/port2" 12)
curl -fsS --cacert "$CERTD/cert.pem" "https://127.0.0.1:$PORT/tv-button-token" >/dev/null 2>&1 && fail "12: ruta sin nonce debia 404"
curl -fsS --cacert "$CERTD/cert.pem" "https://127.0.0.1:$PORT/tv-button-token/otro-nonce" >/dev/null 2>&1 && fail "12: nonce equivocado debia 404"
curl -fsS "https://127.0.0.1:$PORT/tv-button-token/$NONCE" -o /dev/null 2>/dev/null && fail "12: sin --cacert no debia validar"
# Los intentos fallidos NO consumen la unica entrega: con --cacert y el nonce
# correcto sigue sirviendo.
curl -fsSL --cacert "$CERTD/cert.pem" "https://127.0.0.1:$PORT/tv-button-token/$NONCE" -o "$T/tls-out2.conf" || fail "12: la entrega legitima debia seguir disponible"
grep -q 'SECRETO-TLS' "$T/tls-out2.conf" || fail "12: contenido distinto"
wait "$SRV" || fail "12: el one-shot debia morir con exit 0 tras servir"
SRV=""
ok "one-shot TLS: ruta ajena 404, sin cert no valida, entrega legitima intacta"

# 13) cliente desde IP AJENA: 403 y la entrega NO se consume (canario auditor)
python3 "$DIR/tv-token-server.py" --bind 127.0.0.1 --allow-ip 192.0.2.1 --nonce "$NONCE" \
  --file "$T/tls.conf" --cert "$CERTD/cert.pem" --key "$CERTD/key.pem" \
  --port-file "$CERTD/port3" --max-age 2 & SRV=$!
PORT=$(wait_port "$CERTD/port3" 13)
CODE=$(curl -sS --cacert "$CERTD/cert.pem" -o /dev/null -w '%{http_code}' "https://127.0.0.1:$PORT/tv-button-token/$NONCE" || true)
[ "$CODE" = "403" ] || fail "13: IP ajena debia recibir 403 (recibio $CODE)"
RC=0; wait "$SRV" || RC=$?; SRV=""
[ "$RC" = "1" ] || fail "13: la entrega NO debia consumirse con un cliente ajeno (rc=$RC)"
ok "one-shot TLS: IP ajena -> 403, entrega no consumida, expira con exit 1"

# 14) handshake COLGADO no bloquea a la tele legitima (canario auditor:
#     TCP abierto sin ClientHello no puede retener el servidor)
python3 "$DIR/tv-token-server.py" --bind 127.0.0.1 --allow-ip 127.0.0.1 --nonce "$NONCE" \
  --file "$T/tls.conf" --cert "$CERTD/cert.pem" --key "$CERTD/key.pem" \
  --port-file "$CERTD/port4" --max-age 15 --conn-timeout 1 & SRV=$!
PORT=$(wait_port "$CERTD/port4" 14)
python3 - "$PORT" <<'PY' &
import socket, sys, time
s = socket.create_connection(("127.0.0.1", int(sys.argv[1])))
time.sleep(6)  # TCP abierto, jamas un ClientHello
s.close()
PY
STALL=$!
sleep 0.3
curl -fsSL -m 10 --cacert "$CERTD/cert.pem" "https://127.0.0.1:$PORT/tv-button-token/$NONCE" -o "$T/tls-out3.conf" \
  || fail "14: un handshake colgado no debe impedir la entrega legitima"
grep -q 'SECRETO-TLS' "$T/tls-out3.conf" || fail "14: contenido distinto"
wait "$SRV" || fail "14: el one-shot debia morir con exit 0 tras servir"
SRV=""; wait "$STALL" 2>/dev/null || true; STALL=""
ok "one-shot TLS: handshake colgado -> timeout propio, tele legitima servida"

# 15) deadline ABSOLUTO con solo un cliente colgado: max-age manda (canario:
#     antes seguia vivo 1.3 s con max-age 0.5 s)
python3 "$DIR/tv-token-server.py" --bind 127.0.0.1 --allow-ip 127.0.0.1 --nonce "$NONCE" \
  --file "$T/tls.conf" --cert "$CERTD/cert.pem" --key "$CERTD/key.pem" \
  --port-file "$CERTD/port5" --max-age 1 --conn-timeout 1 & SRV=$!
PORT=$(wait_port "$CERTD/port5" 15)
START=$(date +%s)
python3 - "$PORT" <<'PY' &
import socket, sys, time
s = socket.create_connection(("127.0.0.1", int(sys.argv[1])))
time.sleep(8)
s.close()
PY
STALL=$!
RC=0; wait "$SRV" || RC=$?; SRV=""
ELAPSED=$(( $(date +%s) - START ))
[ "$RC" = "1" ] || fail "15: sin entrega debia expirar con exit 1 (rc=$RC)"
[ "$ELAPSED" -lt 6 ] || fail "15: max-age 1 no acoto el handshake colgado (${ELAPSED}s)"
wait "$STALL" 2>/dev/null || true; STALL=""
ok "one-shot TLS: max-age acota el handshake (exit 1 en ${ELAPSED}s con max-age 1)"

# 16) FALLO DE ESCRITURA no consume la entrega (canario: served se marcaba
#     antes de escribir). Cliente que pide y corta con RST antes de recibir;
#     archivo grande para que la escritura no quepa en buffers del kernel.
head -c 16000000 /dev/zero | tr '\0' 'A' > "$T/big.conf"
python3 "$DIR/tv-token-server.py" --bind 127.0.0.1 --allow-ip 127.0.0.1 --nonce "$NONCE" \
  --file "$T/big.conf" --cert "$CERTD/cert.pem" --key "$CERTD/key.pem" \
  --port-file "$CERTD/port6" --max-age 15 & SRV=$!
PORT=$(wait_port "$CERTD/port6" 16)
python3 - "$PORT" "$CERTD/cert.pem" "$NONCE" <<'PY'
import socket, ssl, struct, sys
port, ca, nonce = int(sys.argv[1]), sys.argv[2], sys.argv[3]
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
ctx.load_verify_locations(ca)
s = ctx.wrap_socket(socket.create_connection(("127.0.0.1", port)), server_hostname="127.0.0.1")
s.sendall(("GET /tv-button-token/%s HTTP/1.1\r\nHost: x\r\n\r\n" % nonce).encode())
# RST inmediato: la respuesta de 16 MB no cabe en buffers -> write falla.
s.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
s.close()
PY
sleep 1
kill -0 "$SRV" 2>/dev/null || fail "16: el servidor no debia morir tras el write fallido"
curl -fsSL -m 10 --cacert "$CERTD/cert.pem" "https://127.0.0.1:$PORT/tv-button-token/$NONCE" -o "$T/big-out.conf" \
  || fail "16: el reintento limpio debia servir"
[ "$(wc -c < "$T/big-out.conf" | tr -d ' ')" = "16000000" ] || fail "16: contenido del reintento distinto"
wait "$SRV" || fail "16: exit 0 solo tras la entrega REAL del reintento"
SRV=""
ok "one-shot TLS: write fallido no consume; reintento limpio sirve y cierra 0"

echo "PASS $PASS/16"
