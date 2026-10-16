#!/usr/bin/env python3
"""Servidor HTTPS one-shot para entregar el token del boton TV a la tele.

Por que existe: la tele solo abre telnet (canal EN CLARO), asi que el token
no puede viajar por ahi ni en argv. Este servidor lo entrega por TLS real:
certificado efimero autofirmado generado por el instalador (SAN = IP del
laptop), cuya parte PUBLICA si puede cruzar por telnet, y la tele verifica
con `curl --cacert`. La clave privada nunca sale del PC.

Limites honestos del canal: el cert fijado con --cacert impide que un tercero
suplante al servidor ante la tele, pero como el cert publico cruza por telnet
en claro, un MITM activo en la LAN podria sustituirlo. NO es un canal extremo
a extremo autenticado; la defensa real de la entrega es la combinacion de:

- --allow-ip: SOLO se sirve a la IP de la tele; cualquier otro cliente
  recibe 403 y NO consume la entrega;
- --nonce: la ruta es /tv-button-token/<nonce aleatorio de un solo uso>,
  que cruza por telnet junto al cert. No es un secreto fuerte (viaja en
  claro), pero cierra el escaneo a ciegas de la ruta;
- one-shot: sirve UNA sola peticion valida y muere, con puerto efimero;
- deadline doble: --max-age acota la vida total y CADA conexion aceptada
  (handshake TLS + lectura + escritura) tiene su propio timeout real en el
  socket (--conn-timeout, 10 s por defecto), asi un cliente que conecta y no
  sigue NO bloquea el bucle;
- exit 0 == entrega confirmada: served se marca SOLO tras completar la
  escritura al socket; si el cliente corta antes de recibir, la entrega no
  se consume y el cliente legitimo puede reintentar.

Otras garantias:
- cualquier otra ruta recibe 404 y no revela nada;
- bind a la IP LAN indicada (nunca 0.0.0.0);
- escribe el puerto efimero elegido en --port-file para que el instalador
  se lo pase a la tele;
- no imprime el contenido servido NUNCA.
"""
import argparse
import http.server
import os
import re
import ssl
import sys
import time



class OneShotServer(http.server.HTTPServer):
    def get_request(self):
        # Acepta TCP en claro y envuelve AQUI, no a nivel de socket de escucha:
        # con el wrap sobre el socket de escucha el handshake ocurria dentro de
        # accept() SIN timeout efectivo (el socket aceptado hereda modo
        # bloqueante), y un cliente que abre TCP y no manda ClientHello dejaba
        # el servidor colgado mas alla de --max-age. Aqui el socket aceptado
        # lleva su propio timeout ANTES del handshake, y ese mismo timeout acota
        # despues la lectura de la peticion y la escritura de la respuesta.
        newsock, addr = self.socket.accept()
        remaining = self.deadline - time.monotonic()
        newsock.settimeout(max(0.1, min(remaining, self.conn_timeout)))
        return self.tls_context.wrap_socket(newsock, server_side=True), addr


class OneShotHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 (nombre impuesto por BaseHTTPRequestHandler)
        if self.client_address[0] != self.server.allow_ip:
            self.send_error(403)
            return
        if self.path != self.server.token_path or self.server.served:
            self.send_error(404)
            return
        try:
            with open(self.server.token_file, "rb") as fh:
                body = fh.read()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()
        except (OSError, ssl.SSLError):
            # Escritura NO completada (el cliente corto antes de recibir): la
            # entrega no se consume y queda disponible para un reintento limpio.
            return
        # served SOLO tras una escritura completa: exit 0 prueba la entrega.
        self.server.served = True

    def log_message(self, *args):  # silencio: nada de access log con rutas
        pass


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bind", required=True)
    ap.add_argument("--allow-ip", required=True,
                    help="IP de la tele: la UNICA a la que se sirve el token")
    ap.add_argument("--nonce", required=True,
                    help="nonce aleatorio de un solo uso: la ruta es /tv-button-token/<nonce>")
    ap.add_argument("--file", required=True)
    ap.add_argument("--cert", required=True)
    ap.add_argument("--key", required=True)
    ap.add_argument("--port-file", required=True)
    ap.add_argument("--max-age", type=float, default=120.0)
    ap.add_argument("--conn-timeout", type=float, default=10.0,
                    help="tope por conexion: handshake TLS + peticion + respuesta")
    args = ap.parse_args()

    if not re.fullmatch(r"[A-Za-z0-9_-]{8,64}", args.nonce):
        print("nonce invalido: 8-64 chars de [A-Za-z0-9_-]", file=sys.stderr)
        return 2
    for p in (args.file, args.cert, args.key):
        if not os.path.isfile(p):
            print("no existe: %s" % p, file=sys.stderr)
            return 2

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(args.cert, args.key)

    server = OneShotServer((args.bind, 0), OneShotHandler)
    server.token_file = args.file
    server.allow_ip = args.allow_ip
    server.token_path = "/tv-button-token/" + args.nonce
    server.tls_context = ctx
    server.served = False
    server.conn_timeout = args.conn_timeout
    server.deadline = time.monotonic() + args.max_age

    with open(args.port_file, "w") as fh:
        fh.write(str(server.server_address[1]))

    while not server.served and time.monotonic() < server.deadline:
        server.timeout = max(0.1, server.deadline - time.monotonic())
        try:
            server.handle_request()  # vuelve al servir una o al cumplirse timeout
        except (ssl.SSLError, OSError):
            # Handshake o lectura abortados por el cliente (socket.timeout es
            # un OSError): no es la entrega, el bucle sigue hasta el deadline.
            continue
    server.server_close()
    if not server.served:
        print("one-shot expiro sin servir el token", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
