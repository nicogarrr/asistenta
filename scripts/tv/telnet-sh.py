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
      Escribe <local> en <remote> via `base64 -d` y le aplica chmod <mode>.
      El contenido viaja SOLO por el socket: nunca en argv ni en logs. La
      salida remota no se imprime salvo error (puede contener el eco de lo
      enviado, es decir el propio secreto en base64).

El exit code remoto viaja en un centinela __MM_TELNET_EXIT_<n>__ impreso por
un trap EXIT del propio shell remoto (asi un `exit N` prematuro tambien lo
emite). Si el centinela no llega, es fallo de transporte (exit 3), nunca un
exit 0 optimista.
"""
import base64
import re
import shlex
import socket
import sys

IAC = 0xFF
SENTINEL = re.compile(rb"__MM_TELNET_EXIT_(\d+)__")
EXIT_TRANSPORT = 3


def _filter_iac(chunk: bytes, sock: socket.socket) -> bytes:
    """Quita secuencias IAC del stream; responde DO->WONT y WILL->DONT."""
    out = bytearray()
    i = 0
    while i < len(chunk):
        if chunk[i] == IAC and i + 2 < len(chunk):
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


def _run_session(host, port, opener: bytes, payload: bytes, timeout: float) -> bytes:
    """Abre `opener` (p.ej. `sh -s`) en la tele, manda payload y lee hasta EOF."""
    sock = socket.create_connection((host, port), timeout=timeout)
    try:
        sock.settimeout(timeout)
        # Banner inicial ("~ #" en esta tele). El shell buffera la entrada,
        # pero esperar evita mezclar el banner con la salida del script.
        banner = b""
        while b"#" not in banner and len(banner) < 4096:
            try:
                chunk = sock.recv(1024)
            except socket.timeout:
                break  # sin banner: el shell igualmente buffera la entrada
            if not chunk:
                break
            banner += _filter_iac(chunk, sock)
        # stty -echo: sin eco, lo enviado no vuelve mezclado con la salida
        # (en modo put lo enviado ES el secreto en base64).
        sock.sendall(b"stty -echo 2>/dev/null\n" + opener + b"\n")
        sock.sendall(payload)
        sock.shutdown(socket.SHUT_WR)
        out = b""
        while True:
            try:
                chunk = sock.recv(4096)
            except socket.timeout:
                break
            if not chunk:
                break
            out += _filter_iac(chunk, sock)
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
        b64 = base64.encodebytes(data)  # 76 columnas; busybox base64 -d lo acepta
        payload = (
            b"trap 'echo __MM_TELNET_EXIT_$?__' EXIT\n"
            + b"base64 -d > " + shlex.quote(remote).encode() + b" <<'__MM_B64__'\n"
            + b64
            + b"__MM_B64__\n"
            + b"chmod " + mode_str.encode() + b" " + shlex.quote(remote).encode() + b"\n"
        )
        return _finish(_run_session(host, port, b"sh -s", payload, timeout), quiet=True)

    print("modo desconocido: %r" % mode)
    return 2


if __name__ == "__main__":
    sys.exit(main())
