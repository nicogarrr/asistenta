"""Smoke real #130: Camoufox de verdad + redirect + subrecurso, todo loopback real.

Puerto efimero (0) para no interferir con nada previo, perfiles en un
TemporaryDirectory y cierre ORDENADO y OBLIGATORIO: la sesion se borra via API,
uvicorn se apaga y se espera su join ANTES de soltar el TemporaryDirectory.
Un fallo de limpieza es un FAIL del smoke, nunca un PASS con aviso.
"""
import json
import os
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOOK_SEEN = []


class Origin(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/r":
            self.send_response(302)
            self.send_header("Location", "/final")
            self.end_headers()
            return
        if self.path == "/final":
            return self._send("<html><head><script src='/s.js'></script></head><body>destino-final-real</body></html>")
        if self.path == "/s.js":
            return self._send("window.__s=1;", "text/javascript")
        if self.path == "/img.png":
            return self._send("PNG", "image/png")
        self._send("no", code=404)

    def _send(self, body, ctype="text/html", code=200):
        d = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(d)))
        self.end_headers()
        self.wfile.write(d)

    def log_message(self, *a):
        pass


class Hook(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        p = json.loads(self.rfile.read(n) or b"{}")
        HOOK_SEEN.append(p)
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *a):
        pass


def main() -> int:
    origin = ThreadingHTTPServer(("127.0.0.1", 0), Origin)
    hook = ThreadingHTTPServer(("127.0.0.1", 0), Hook)
    for s in (origin, hook):
        threading.Thread(target=s.serve_forever, daemon=True).start()
    op, hp = origin.server_address[1], hook.server_address[1]

    srv = None
    srv_thread = None
    try:
        with tempfile.TemporaryDirectory(prefix="bdprofiles-smoke-") as profiles:
            os.environ["BROWSERD_PROFILES_DIR"] = profiles
            os.environ.pop("BROWSERD_PORT", None)  # el smoke usa su propio puerto efimero
            from browserd.server import app
            import uvicorn

            srv = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=0, log_level="error"))
            srv_thread = threading.Thread(target=srv.run, daemon=True)
            srv_thread.start()

            base = None
            for _ in range(120):
                if srv.started and srv.servers:
                    port = srv.servers[0].sockets[0].getsockname()[1]
                    try:
                        if urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1).status == 200:
                            base = f"http://127.0.0.1:{port}"
                            break
                    except Exception:
                        pass
                time.sleep(0.5)
            if base is None:
                print("SMOKE-REAL: FAIL (browserd no arranco)", flush=True)
                return 1

            def post(path, payload):
                r = urllib.request.Request(
                    base + path,
                    data=json.dumps(payload).encode(),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                return json.loads(urllib.request.urlopen(r, timeout=180).read())

            print("creando sesion (camoufox real, tarda)...", flush=True)
            sid = post("/sessions", {"scope": "smoke"})["id"]
            print("sesion", sid, flush=True)

            closed = False
            close_error = None
            try:
                res = post(f"/sessions/{sid}/read", {
                    "url": f"http://127.0.0.1:{op}/r",
                    "expression": "document.documentElement.outerHTML",
                    "allowed_hosts": ["127.0.0.1"],
                    "permit_url": f"http://127.0.0.1:{hp}/permit",
                    "require_https": False,  # smoke loopback HTTP (la opcion de test)
                    "settle_ms": 2000,
                })
            finally:
                # El cierre de sesion (que cierra el navegador y suelta el
                # perfil) es parte del contrato del smoke, no un aviso.
                try:
                    req = urllib.request.Request(f"{base}/sessions/{sid}", method="DELETE")
                    closed = urllib.request.urlopen(req, timeout=60).status == 200
                except Exception as e:
                    close_error = e

            print("status:", res["status"], "| url final:", res["url"], "| denied:", res["denied"], flush=True)
            html = res.get("value") or ""
            print("contiene destino-final-real:", "destino-final-real" in html, flush=True)
            print("sesion cerrada via DELETE:", closed, ("| error: " + str(close_error)) if close_error else "", flush=True)
            print("hook vio (url, fase, status):", flush=True)
            for p in HOOK_SEEN:
                print("  ", p.get("resource_type"), p.get("url"), "post" if "status" in p else "PRE", p.get("status", ""), flush=True)

            ok = (
                res["status"] == 200
                and "destino-final-real" in html
                and closed
                and any(p.get("url", "").endswith("/r") and "status" not in p for p in HOOK_SEEN)
                and any(p.get("url", "").endswith("/r") and p.get("status") == 302 for p in HOOK_SEEN)
                and any(p.get("url", "").endswith("/final") and "status" not in p for p in HOOK_SEEN)
                and any(p.get("url", "").endswith("/s.js") for p in HOOK_SEEN)
            )

            # Apagado ordenado ANTES de soltar el TemporaryDirectory: en Windows
            # borrar perfiles con el navegador aun vivo falla o deja restos.
            srv.should_exit = True
            srv_thread.join(timeout=30)
            if srv_thread.is_alive():
                print("SMOKE-REAL: FAIL (uvicorn no cerro en 30s)", flush=True)
                return 1
            srv = None
            srv_thread = None

            print("SMOKE-REAL:", "PASS" if ok else "FAIL", flush=True)
            return 0 if ok else 1
    finally:
        if srv is not None:
            srv.should_exit = True
        if srv_thread is not None:
            srv_thread.join(timeout=10)
        for s in (origin, hook):
            s.shutdown()
            s.server_close()


if __name__ == "__main__":
    sys.exit(main())
