"""Sondeo del contrato /health de browserd para el launcher de arranque.

Codigos de salida (FAIL-CLOSED, auditoria ronda 4):
  0 = responde un browserd VALIDO (service=browserd, version, capability read)
  1 = NO arrancar: responde algo que no cumple el contrato, no-200, TIMEOUT,
      error de protocolo o cualquier otra cosa rara. Un timeout con el puerto
      ocupado NO es "puerto libre".
  2 = puerto libre, y solo eso: la conexion fue RECHAZADA
      (ConnectionRefusedError). Ningun otro error significa "libre".

El launcher (start-browserd-hidden.vbs) arranca SOLO con 2, adopta con 0 y
sale con 1 en cualquier otro caso, incluido un helper caido o ausente.

La validacion es JSON real y con tipos: capabilities tiene que ser una LISTA
de strings que contenga "read"; la string "unread" no vale (substring != item).
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request


def probe(url: str, timeout: float = 3.0) -> int:
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = resp.status
            raw = resp.read(64 * 1024)
    except urllib.error.HTTPError:
        return 1  # responde, pero ni siquiera es un 200
    except urllib.error.URLError as e:
        # URLError envuelve la causa: solo "conexion rechazada" es puerto
        # libre; timeouts y resets NO lo son (fail-closed).
        return 2 if isinstance(e.reason, ConnectionRefusedError) else 1
    except OSError as e:
        return 2 if isinstance(e, ConnectionRefusedError) else 1
    try:
        data = json.loads(raw)
    except ValueError:
        return 1  # 200 con cuerpo no-JSON (HTML, texto...) no es el contrato
    caps = data.get("capabilities") if isinstance(data, dict) else None
    caps_ok = isinstance(caps, list) and all(isinstance(c, str) for c in caps) and "read" in caps
    ok = (
        status == 200
        and isinstance(data, dict)
        and data.get("service") == "browserd"
        and isinstance(data.get("version"), str) and bool(data.get("version"))  # string, no 123 ni true
        and caps_ok
    )
    return 0 if ok else 1


if __name__ == "__main__":
    url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:7701/health"
    sys.exit(probe(url))
