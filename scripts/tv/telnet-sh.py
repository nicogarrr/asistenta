#!/usr/bin/env python3
"""Driver telnet minimo para la tele LG (root sin login, puerto 23).

La tele abre un shell root directo (banner "~ #"), sin negociacion de login,
asi que basta un socket TCP con filtrado IAC basico. Se usa cuando la tele no
tiene servidor SSH levantado (install-magic-mapper.sh --transport telnet).

Modos:

  sh <host> [--port N] [--timeout S] -- [args...]
      Ejecuta `sh -s -- args...` en la tele con el SCRIPT leido de stdin.
      La salida remota se vuelca a stdout tal cual.
  put <host> <local> <remote> <mode> [--port N] [--timeout S]
      Escribe <local> en <remote> via `base64 -d` con `set -e`: un fallo de
      decode, escritura, verificacion o chmod PROPAGA su exit code (nunca un
      0 optimista con el destino vacio). El archivo se escribe en un temporal
      (umask 077), se valida tamano y sha256 contra lo leido en local y SOLO
      entonces se mueve (mv) al destino: un upload corrupto nunca "activa" un
      archivo a medias. El contenido viaja SOLO por el socket: nunca en argv
      ni en logs. La salida remota no se imprime salvo error (puede contener
      el eco de lo enviado, es decir el propio secreto en base64).

El exit code remoto viaja en un centinela __MM_TELNET_EXIT_<n>__ impreso por
un trap EXIT del propio shell remoto (asi un `exit N` prematuro tambien lo
emite). Si el centinela no llega, es fallo de transporte (exit 3), nunca un
exit 0 optimista.
"""
import base64
import hashlib
import re
import shlex
import socket
import sys
import time

IAC = 0xFF
SENTINEL = re.compile(rb"__MM_TELNET_EXIT_(\d+)__")
EXIT_TRANSPORT = 3


def _filter_iac(chunk: bytes, sock: socket.socket) -> bytes:
    """Quita secuencias IAC del stream; responde DO->WONT y WILL->DONT."""
    out = bytearray()
    i = 0
    while i < len(chunk):
        if chunk[i] == IAC:
            if i + 2 >= len(chunk):
                break  # secuencia IAC cortada a fin de chunk: se descarta
            cmd, opt = chunk[i + 1], chunk[i + 2]
            if cmd == 253:  # DO -> WONT
                sock.sendall(bytes([IAC, 252, opt]))
            elif cmd == 251:  # WILL -> DONT
                sock.sendall(bytes([IAC, 254, opt]))
            i += 3
        else:
            out.append(chunk[i])
            i += 1
    return bytes(out)


def _recv_filtered(sock: socket.socket, timeout: float):
    """Un recv filtrado. Devuelve (estado, datos) con estado en
    'data' | 'timeout' | 'eof'; datos puede ser b'' (chunk que era solo IAC)."""
    try:
        sock.settimeout(timeout)
        chunk = sock.recv(4096)
    except socket.timeout:
        return "timeout", b""
    if not chunk:
        return "eof", b""
    return "data", _filter_iac(chunk, sock)


# Silencio que marca "fase asentada". Este telnetd lee por delante y se traga
# el script si llega pegado al `sh -s` (lo consume el shell externo y el
# interno nace vacio), asi que entre fase y fase se espera a que no llegue
# nada: con el shell en reposo, la siguiente linea va a quien debe.
QUIET = 0.4


def _drain(sock: socket.socket, quiet: float) -> bytes:
    """Vacia lo pendiente de la fase anterior: lee hasta `quiet` s sin datos."""
    got = b""
    while True:
        status, data = _recv_filtered(sock, quiet)
        if status != "data":
            return got
        got += data


def _run_session(host, port, opener: bytes, payload: bytes, timeout: float) -> bytes:
    """Abre `opener` (p.ej. `sh -s`) en la tele, manda payload y lee hasta el centinela.

    Handshake por fases separadas por silencio (QUIET): este telnetd lee por
    delante y se traga el script si llega pegado al `sh -s` (lo consume el
    shell externo y el interno nace vacio); y el FIN del cliente cierra la
    sesion en seco, perdiendo la salida pendiente (nada de shutdown SHUT_WR).
    El EOF de stdin del sh interno se manda como Ctrl-D sobre el pty.
    """
    if not payload.endswith(b"\n"):
        payload += b"\n"
    try:
        sock = socket.create_connection((host, port), timeout=timeout)
    except OSError:
        return b""  # tele apagada o inalcanzable: fallo de transporte visible
    try:
        sock.settimeout(timeout)
        out = b""
        try:
            # El banner puede tardar mas que QUIET: el primer byte se espera
            # con el timeout completo y solo entonces drena por silencio.
            status, first = _recv_filtered(sock, timeout)
            if status == "data":
                out = first + _drain(sock, QUIET)  # banner ("~ #")
            if out:
                # stty -echo: sin eco, lo enviado no vuelve mezclado con la salida.
                sock.settimeout(timeout)
                sock.sendall(b"stty -echo 2>/dev/null\n")
                out += _drain(sock, QUIET)
                sock.sendall(opener + b"\n")
                out += _drain(sock, QUIET)  # shell interno en reposo: listo para el script
                sock.settimeout(timeout)  # el drenaje lo dejo en QUIET; el payload puede ser grande
                sock.sendall(payload)
                sock.sendall(b"\x04")  # EOF de stdin del sh interno -> trap EXIT
                deadline = time.monotonic() + timeout
                while SENTINEL.search(out) is None:
                    left = deadline - time.monotonic()
                    if left <= 0:
                        break
                    status, data = _recv_filtered(sock, min(left, 1.0))
                    if status == "eof":
                        break
                    if status == "data":
                        out += data
                out += _drain(sock, 0.15)
        except OSError:
            pass  # la tele cerro: sin centinela -> fallo de transporte visible
        return out
    finally:
        sock.close()


def _finish(raw: bytes, quiet: bool) -> int:
    matches = SENTINEL.findall(raw)
    if not matches:
        sys.stderr.write("FALLO DE TRANSPORTE: la tele cerro sin centinela de exit\n")
        return EXIT_TRANSPORT
    code = int(matches[-1])  # el ultimo: los ecos del literal no llevan digitos
    body = SENTINEL.sub(b"", raw).replace(b"echo __MM_TELNET_EXIT_$?__\n", b"")
    if not quiet or code != 0:
        sys.stdout.buffer.write(body)
        sys.stdout.buffer.flush()
    return code


def _opts(argv):
    timeout, port, rest = 30.0, 23, []
    it = iter(argv)
    for a in it:
        if a == "--timeout":
            timeout = float(next(it))
        elif a == "--port":
            port = int(next(it))
        else:
            rest.append(a)
    return timeout, port, rest


def _put_payload(remote: str, mode_str: str, data: bytes) -> bytes:
    """Script remoto del modo put: decode + verificacion + mv atomico.

    set -e es la pieza que faltaba: sin el, un `base64 -d` roto dejaba el
    destino vacio y el centinela reportaba exit 0 porque el chmod final
    pasaba. Ahora cada paso falla visible y el destino solo se toca con el
    mv final, despues de validar tamano y sha256 del temporal.
    """
    digest = hashlib.sha256(data).hexdigest()
    size = len(data)
    b64 = base64.encodebytes(data)  # 76 columnas; busybox base64 -d lo acepta
    tmp = shlex.quote(remote + ".mmtmp").encode()
    dest = shlex.quote(remote).encode()
    lines = [
        b"tmp=" + tmp,
        # El trap limpia el temporal y conserva el centinela de exit code.
        b"trap 'rc=$?; rm -f \"$tmp\"; echo __MM_TELNET_EXIT_${rc}__' EXIT",
        b"set -e",
        b"umask 077",
        b"base64 -d > \"$tmp\" <<'__MM_B64__'",
        b64.rstrip(b"\n"),
        b"__MM_B64__",
        b'[ "$(wc -c < "$tmp" | tr -d " ")" = "' + str(size).encode() + b'" ]',
        # El hash se verifica con python3 (la tele lo tiene; sha256sum no esta
        # confirmado). Si python3 faltara, el put FALLA visible, nunca activa.
        b'python3 - "$tmp" "' + digest.encode() + b'" <<\'__MM_HASH__\'',
        b"import hashlib, sys",
        b"sys.exit(0 if hashlib.sha256(open(sys.argv[1], 'rb').read()).hexdigest() == sys.argv[2] else 1)",
        b"__MM_HASH__",
        b"chmod " + mode_str.encode() + b" \"$tmp\"",
        b"mv \"$tmp\" " + dest,
    ]
    return b"\n".join(lines) + b"\n"


def main() -> int:
    argv = sys.argv[1:]
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 2
    mode = argv.pop(0)
    timeout, port, args = _opts(argv)

    if mode == "sh":
        if not args:
            print("uso: telnet-sh.py sh <host> [--port N] [--timeout S] -- [args...]")
            return 2
        host = args[0]
        extra = args[1:]
        if extra and extra[0] == "--":
            extra = extra[1:]
        opener = b"sh -s"
        if extra:
            opener += b" -- " + " ".join(shlex.quote(a) for a in extra).encode()
        script = sys.stdin.buffer.read()
        # El exit code viaja en un trap EXIT: un `exit N` dentro del script
        # tambien imprime el centinela (con un echo final en el stream, un
        # exit prematuro se lo saltaria y pareceria fallo de transporte).
        payload = b"trap 'echo __MM_TELNET_EXIT_$?__' EXIT\n" + script
        return _finish(_run_session(host, port, opener, payload, timeout), quiet=False)

    if mode == "put":
        if len(args) != 4:
            print("uso: telnet-sh.py put <host> <local> <remote> <mode> [--port N] [--timeout S]")
            return 2
        host, local, remote, mode_str = args
        if not re.fullmatch(r"[0-7]{3,4}", mode_str):
            print("modo invalido: %r" % mode_str)
            return 2
        with open(local, "rb") as fh:
            data = fh.read()
        return _finish(
            _run_session(host, port, b"sh -s", _put_payload(remote, mode_str, data), timeout),
            quiet=True,
        )

    print("modo desconocido: %r" % mode)
    return 2


if __name__ == "__main__":
    sys.exit(main())
