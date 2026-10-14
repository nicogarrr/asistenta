"""Tests de la barrera por request (auditoria #130, rondas 1-3).

Los tests de red usan servidores HTTP REALES (origen con redirects y hook de
permit) en threads; solo el objeto route de playwright es falso, y su fetch
viaja por httpx contra el origen real.
"""
from __future__ import annotations

import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

import httpx
import pytest

from browserd.guard import PermitUrlError, RequestGuard, host_covered, validate_permit_url


# ---------- unidad pura ----------

def test_host_covered_dominio_y_subdominio():
    assert host_covered(["amazon.es"], "https://www.amazon.es/s?k=tv")
    assert host_covered(["amazon.es"], "https://amazon.es/")
    assert not host_covered(["amazon.es"], "https://amazon.es.evil.test/")
    assert not host_covered(["amazon.es"], "https://notamazon.es/")
    assert not host_covered(["amazon.es"], "https://localhost/")


def test_validate_permit_url_solo_loopback():
    validate_permit_url("http://127.0.0.1:9900/permit")
    validate_permit_url("http://localhost:1/x")
    for bad in ("http://169.254.169.254/meta", "https://evil.example/x", "file:///etc/passwd", "http://[::]/x"):
        with pytest.raises(PermitUrlError):
            validate_permit_url(bad)


def test_guard_sin_opciones_no_corta_nada():
    g = RequestGuard(None, None)
    assert g.allowed_hosts == []
    assert g.permit_url is None


# ---------- servidores reales ----------

CHALLENGE_BODY = '<script>triggerInterstitialChallenge({"bm-verify":true})</script>'


class _Origin(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/redir":
            self.send_response(302)
            self.send_header("Location", "/final")
            self.end_headers()
            return
        if self.path == "/final":
            return self._send(200, "<html><body>pagina final real</body></html>")
        if self.path == "/script.js":
            return self._send(200, "console.log('subrecurso real');", "text/javascript")
        if self.path == "/challenge":
            return self._send(200, CHALLENGE_BODY)
        self._send(404, "no")

    def _send(self, code, body, ctype="text/html"):
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


class _Hook(BaseHTTPRequestHandler):
    seen: list[dict] = []

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        payload = json.loads(self.rfile.read(n) or b"{}")
        type(self).seen.append(payload)
        # Niega challenges (misma decision que isBlockedPage del cliente)
        allow = "triggerInterstitialChallenge" not in str(payload.get("body", ""))
        self.send_response(200 if allow else 403)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *a):
        pass


@pytest.fixture()
def servers():
    origin = ThreadingHTTPServer(("127.0.0.1", 0), _Origin)
    hook = ThreadingHTTPServer(("127.0.0.1", 0), _Hook)
    _Hook.seen = []
    for srv in (origin, hook):
        threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{origin.server_address[1]}", f"http://127.0.0.1:{hook.server_address[1]}/permit"
    origin.shutdown()
    hook.shutdown()


class _FakeResp:
    def __init__(self, r: httpx.Response):
        self.status = r.status_code
        self._body = r.content

    async def body(self):
        return self._body


class _FakeRoute:
    """Solo el route es falso; su fetch viaja por httpx REAL al origen (un salto)."""

    def __init__(self, url: str):
        self.url = url
        self.aborted = False
        self.fulfilled: tuple[int, bytes] | None = None
        self.fetch_kwargs: dict = {}

    async def abort(self):
        self.aborted = True

    async def fetch(self, **kwargs):
        self.fetch_kwargs = kwargs
        async with httpx.AsyncClient(follow_redirects=False, timeout=10) as c:
            return _FakeResp(await c.get(self.url))

    async def fulfill(self, response=None, body=None):
        self.fulfilled = (response.status, body)


class _Req:
    def __init__(self, url, rtype):
        self.url = url
        self.resource_type = rtype


def _handle(g, url, rtype):
    route = _FakeRoute(url)
    asyncio.run(g.handle(route, _Req(url, rtype)))
    return route


# ---------- tests con red real ----------

def test_redirect_no_se_sigue_dentro_y_llega_al_hook_como_302(servers):
    origin, hook = servers
    g = RequestGuard(["127.0.0.1"], hook)
    route = _handle(g, f"{origin}/redir", "document")
    assert route.fetch_kwargs.get("max_redirects") == 0
    assert route.fulfilled and route.fulfilled[0] == 302  # NO siguio a /final
    assert not route.aborted and not g.denied
    assert _Hook.seen[-1]["status"] == 302  # el hook vio el 302, no el destino


def test_subrecurso_real_un_salto_y_hook_recibe_cuerpo(servers):
    origin, hook = servers
    g = RequestGuard(["127.0.0.1"], hook)
    route = _handle(g, f"{origin}/script.js", "script")
    assert route.fulfilled and route.fulfilled[0] == 200
    assert b"subrecurso real" in route.fulfilled[1]
    seen = _Hook.seen[-1]
    assert seen["resource_type"] == "script" and "subrecurso real" in seen["body"]


def test_challenge_real_en_subrecurso_lo_corta_el_hook_y_marca_denied(servers):
    origin, hook = servers
    g = RequestGuard(["127.0.0.1"], hook)
    route = _handle(g, f"{origin}/challenge", "xhr")
    assert route.aborted and g.denied and route.fulfilled is None


def test_tipos_no_permitidos_se_abortan_sin_salir_a_la_red(servers):
    origin, hook = servers
    g = RequestGuard(["127.0.0.1"], hook)
    for rtype in ("image", "media", "font", "stylesheet", "websocket"):
        route = _handle(g, f"{origin}/final", rtype)
        assert route.aborted
        assert route.fulfilled is None
        assert route.fetch_kwargs == {}  # ni siquiera se pidio a la red
    assert not g.denied  # abortar por tipo no es una denegacion de permiso


def test_host_fuera_de_allowlist_aborta_sin_red(servers):
    origin, hook = servers
    g = RequestGuard(["amazon.es"], hook)
    route = _handle(g, f"{origin}/final", "document")
    assert route.aborted and route.fetch_kwargs == {}
    assert g.denied
    assert _Hook.seen == []  # el hook ni se entero


def test_hook_caido_fail_closed():
    g = RequestGuard(None, "http://127.0.0.1:9/permit", permit_timeout_s=1.0)
    route = _FakeRoute("http://127.0.0.1:9/final")
    # fetch al origen caido tambien falla -> el guard nunca llega a fulfill;
    # para isolar: origen vivo solo si hay servers; aqui basta probar deny del hook
    async def run():
        try:
            await g._permit("http://x/", "document", 200, b"ok")
        except Exception:
            return "raise"
        return "done"
    assert asyncio.run(run()) == "done"
    assert asyncio.run(g._permit("http://x/", "document", 200, b"ok")) is False
