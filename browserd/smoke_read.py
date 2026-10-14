"""Smoke real #130: Camoufox de verdad + redirect + subrecurso, todo loopback real."""
import json, threading, time, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOOK_SEEN = []

class Origin(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/r":
            self.send_response(302); self.send_header("Location", "/final"); self.end_headers(); return
        if self.path == "/final":
            return self._send("<html><head><script src='/s.js'></script></head><body>destino-final-real</body></html>")
        if self.path == "/s.js":
            return self._send("window.__s=1;", "text/javascript")
        if self.path == "/img.png":
            return self._send("PNG", "image/png")
        self._send("no", code=404)
    def _send(self, body, ctype="text/html", code=200):
        d = body.encode()
        self.send_response(code); self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(d))); self.end_headers(); self.wfile.write(d)
    def log_message(self, *a): pass

class Hook(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        p = json.loads(self.rfile.read(n) or b"{}")
        HOOK_SEEN.append(p)
        self.send_response(200); self.send_header("Content-Length", "0"); self.end_headers()
    def log_message(self, *a): pass

origin = ThreadingHTTPServer(("127.0.0.1", 0), Origin)
hook = ThreadingHTTPServer(("127.0.0.1", 0), Hook)
for s in (origin, hook):
    threading.Thread(target=s.serve_forever, daemon=True).start()
OP, HP = origin.server_address[1], hook.server_address[1]

import os
os.environ["BROWSERD_PROFILES_DIR"] = "/tmp/bdprofiles-smoke"
os.environ["BROWSERD_PORT"] = "17731"
from browserd.server import app
import uvicorn
srv = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=17731, log_level="error"))
threading.Thread(target=srv.run, daemon=True).start()
for _ in range(60):
    try:
        import urllib.request
        if urllib.request.urlopen("http://127.0.0.1:17731/health", timeout=1).status == 200:
            break
    except Exception:
        time.sleep(0.5)

import urllib.request
def post(path, payload):
    r = urllib.request.Request("http://127.0.0.1:17731" + path, data=json.dumps(payload).encode(),
                               headers={"Content-Type": "application/json"}, method="POST")
    return json.loads(urllib.request.urlopen(r, timeout=180).read())

print("creando sesion (camoufox real, tarda)...", flush=True)
sid = post("/sessions", {"scope": "smoke"})["id"]
print("sesion", sid, flush=True)
res = post(f"/sessions/{sid}/read", {
    "url": f"http://127.0.0.1:{OP}/r",
    "expression": "document.documentElement.outerHTML",
    "allowed_hosts": ["127.0.0.1"],
    "permit_url": f"http://127.0.0.1:{HP}/permit",
    "settle_ms": 2000,
})
print("status:", res["status"], "| url final:", res["url"], "| denied:", res["denied"], flush=True)
html = res.get("value") or ""
print("contiene destino-final-real:", "destino-final-real" in html, flush=True)
print("hook vio (url, fase, status):", flush=True)
for p in HOOK_SEEN:
    print("  ", p.get("resource_type"), p.get("url"), "post" if "status" in p else "PRE", p.get("status", ""), flush=True)

ok = (
    res["status"] == 200
    and "destino-final-real" in html
    and any(p.get("url", "").endswith("/r") and "status" not in p for p in HOOK_SEEN)  # preflight /r
    and any(p.get("url", "").endswith("/r") and p.get("status") == 302 for p in HOOK_SEEN)  # postflight vio 302
    and any(p.get("url", "").endswith("/final") and "status" not in p for p in HOOK_SEEN)  # redirect RE-INTERCEPTADO
    and any(p.get("url", "").endswith("/s.js") for p in HOOK_SEEN)  # subrecurso por la barrera
)
print("SMOKE-REAL:", "PASS" if ok else "FAIL", flush=True)
sys.exit(0 if ok else 1)
