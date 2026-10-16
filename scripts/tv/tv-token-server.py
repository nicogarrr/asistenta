#!/usr/bin/env python3
"""Servidor HTTPS one-shot para entregar el token del boton TV a la tele.

Por que existe: la tele solo abre telnet (canal EN CLARO), asi que el token
no puede viajar por ahi ni en argv. Este servidor lo entrega por TLS real:
certificado efimero autofirmado generado por el instalador (SAN = IP del
laptop), cuya parte PUBLICA si puede cruzar por telnet, y la tele verifica
con `curl --cacert`. La clave privada nunca sale del PC.

Garantias:
- sirve UNA sola peticion valida (GET de la ruta fija) y muere;
- cualquier otra ruta recibe 404 y no revela nada;
- bind a la IP LAN indicada (nunca 0.0.0.0);
- escribe el puerto efimero elegido en --port-file para que el instalador
  se lo pase a la tele;
- no imprime el contenido servido;
- a los --max-age segundos sin servir muere con exit 1 (nunca queda abierto).
"""
import argparse
import http.server
import os
import ssl
import sys
import time

TOKEN_PATH = "/tv-button-token"


class OneShotHandler(http.server.BaseHTTPRequestHandler):
    served = False

    def do_GET(self):  # noqa: N802 (nombre impuesto por BaseHTTPRequestHandler)
        if self.path != TOKEN_PATH or OneShotHandler.served:
            self.send_error(404)
            return
        OneShotHandler.served = True
        with open(self.server.token_file, "rb") as fh:
            body = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # silencio: nada de access log con rutas
        pass


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bind", required=True)
    ap.add_argument("--file", required=True)
    ap.add_argument("--cert", required=True)
    ap.add_argument("--key", required=True)
    ap.add_argument("--port-file", required=True)
    ap.add_argument("--max-age", type=float, default=120.0)
    args = ap.parse_args()

    for p in (args.file, args.cert, args.key):
        if not os.path.isfile(p):
            print("no existe: %s" % p, file=sys.stderr)
            return 2

    server = http.server.HTTPServer((args.bind, 0), OneShotHandler)
    server.token_file = args.file
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(args.cert, args.key)
    server.socket = ctx.wrap_socket(server.socket, server_side=True)

    with open(args.port_file, "w") as fh:
        fh.write(str(server.server_address[1]))

    deadline = time.monotonic() + args.max_age
    while not OneShotHandler.served and time.monotonic() < deadline:
        server.timeout = max(0.1, deadline - time.monotonic())
        try:
            server.handle_request()  # vuelve al servir una o al cumplirse timeout
        except (ssl.SSLError, OSError):
            continue  # handshake abortado por el cliente: no es la entrega
    server.server_close()
    if not OneShotHandler.served:
        print("one-shot expiro sin servir el token", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
