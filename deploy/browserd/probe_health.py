"""Sondeo del contrato /health de browserd para el launcher de arranque.

Codigos de salida:
  0 = responde un browserd VALIDO (service=browserd, version, capability read)
  1 = responde algo que NO cumple el contrato (JSON ajeno, HTML, no-200...)
  2 = nadie escucha en ese host:puerto

El launcher (start-browserd-hidden.vbs) lo usa para decidir entre adoptar la
instancia viva, negarse a competir por el puerto o arrancar una nueva. La
validacion es JSON real: el chequeo por subcadenas que sustituye aceptaba un
{"error": "browserd not ready"} o cualquier HTML con las palabras sueltas
(auditoria, ronda 3).
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
    except (urllib.error.URLError, OSError):
        return 2  # no escucha nadie
    try:
        data = json.loads(raw)
    except ValueError:
        return 1  # 200 con cuerpo no-JSON (HTML, texto...) no es el contrato
    ok = (
        status == 200
        and isinstance(data, dict)
        and data.get("service") == "browserd"
        and bool(data.get("version"))
        and "read" in (data.get("capabilities") or [])
    )
    return 0 if ok else 1


if __name__ == "__main__":
    url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:7701/health"
    sys.exit(probe(url))
