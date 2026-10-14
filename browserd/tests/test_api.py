"""API con manager inyectado: flujo HTTP completo sin navegador real."""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from browserd.config import Settings
from browserd.server import app
from browserd.sessions import SessionManager


class FakePage:
    def __init__(self):
        self.url = "about:blank"
        self._closed = False

    def is_closed(self):
        return self._closed

    async def goto(self, url, wait_until, timeout):
        self.url = url

        class R:
            status = 200
        return R()

    async def wait_for_timeout(self, ms):
        return None

    async def title(self):
        return "titulo de prueba"

    async def evaluate(self, expression):
        if expression == "nunca":
            await asyncio.sleep(60)
        return {"expr": expression}

    async def route(self, pattern, handler):
        self.routed = (pattern, handler)

    async def unroute(self, pattern, handler):
        self.routed = None

    async def close(self):
        self._closed = True


class FakeEngine:
    def __init__(self):
        self.page = FakePage()

    async def new_page(self):
        return self.page

    async def close(self):
        self.page._closed = True


def client(tmp_path: Path, token: str = "", eval_timeout_ms: int = 30000,
           launcher=None) -> TestClient:
    async def default_launcher(scope, profile_dir, headless):
        return FakeEngine()

    app.state.settings = Settings(token=token, eval_timeout_ms=eval_timeout_ms)
    app.state.manager = SessionManager(profiles_dir=tmp_path, launcher=launcher or default_launcher)
    return TestClient(app, base_url="http://localhost")


def test_health(tmp_path):
    c = client(tmp_path)
    r = c.get("/health")
    assert r.status_code == 200 and r.json()["ok"] is True


def test_full_flow(tmp_path):
    c = client(tmp_path)
    sid = c.post("/sessions", json={"scope": "amazon"}).json()["id"]
    g = c.post(f"/sessions/{sid}/goto", json={"url": "https://example.com"})
    assert g.status_code == 200 and g.json()["status"] == 200
    e = c.post(f"/sessions/{sid}/evaluate", json={"expression": "1+1"})
    assert e.json()["value"] == {"expr": "1+1"}
    assert c.delete(f"/sessions/{sid}").json()["closed"] is True
    assert c.get("/sessions").json() == []


def test_token(tmp_path):
    c = client(tmp_path, token="secreto")
    assert c.post("/sessions", json={"scope": "a"}).status_code == 401
    r = c.post("/sessions", json={"scope": "a"}, headers={"Authorization": "Bearer secreto"})
    assert r.status_code == 201


# --- Canarios de seguridad #129 -----------------------------------------------

def test_host_ajeno_rechazado(tmp_path):
    c = client(tmp_path)
    r = c.post("/sessions", json={"scope": "a"}, headers={"Host": "attacker.example"})
    assert r.status_code == 403


def test_origin_ajeno_rechazado(tmp_path):
    c = client(tmp_path)
    r = c.post("/sessions", json={"scope": "a"},
               headers={"Origin": "https://attacker.example"})
    assert r.status_code == 403


def test_origin_loopback_aceptado(tmp_path):
    c = client(tmp_path)
    r = c.post("/sessions", json={"scope": "a"},
               headers={"Origin": "http://localhost:7701"})
    assert r.status_code == 201


def test_bind_externo_sin_token_no_arranca():
    with pytest.raises(ValueError):
        Settings(host="0.0.0.0", token="")


def test_bind_externo_con_token_ok():
    assert Settings(host="0.0.0.0", token="x" * 32).host == "0.0.0.0"


# --- Menores #129 --------------------------------------------------------------

def test_launcher_roto_es_503_controlado(tmp_path):
    async def launcher_roto(scope, profile_dir, headless):
        raise RuntimeError("camoufox no instalado")

    c = client(tmp_path, launcher=launcher_roto)
    r = c.post("/sessions", json={"scope": "a"})
    assert r.status_code == 503 and "motor" in r.json()["detail"]


def test_evaluate_tiene_timeout(tmp_path):
    c = client(tmp_path, eval_timeout_ms=1000)
    sid = c.post("/sessions", json={"scope": "a"}).json()["id"]
    c.post(f"/sessions/{sid}/goto", json={"url": "https://example.com"})
    r = c.post(f"/sessions/{sid}/evaluate", json={"expression": "nunca"})
    assert r.status_code == 504


def test_read_atomico_devuelve_valor_y_cierra_la_pagina(tmp_path):
    c = client(tmp_path)
    sid = c.post("/sessions", json={"scope": "t"}).json()["id"]
    r = c.post(f"/sessions/{sid}/read", json={"url": "https://example.com", "expression": "1+1"})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == 200 and body["value"] == {"expr": "1+1"}
    engine_page = app.state.manager.get(sid).engine.page
    assert engine_page.is_closed()  # sin pagina viva entre lecturas
    assert app.state.manager.get(sid).page is None


def test_read_instala_la_barrera_durante_la_operacion(tmp_path):
    c = client(tmp_path)
    sid = c.post("/sessions", json={"scope": "t"}).json()["id"]
    r = c.post(
        f"/sessions/{sid}/read",
        json={"url": "https://example.com", "expression": "1",
              "allowed_hosts": ["example.com"]},
    )
    assert r.status_code == 200
    page = app.state.manager.get(sid).engine.page
    assert page.routed is not None and page.routed[0] == "**/*"


def test_read_permit_url_no_loopback_es_422(tmp_path):
    c = client(tmp_path)
    sid = c.post("/sessions", json={"scope": "t"}).json()["id"]
    r = c.post(
        f"/sessions/{sid}/read",
        json={"url": "https://example.com", "expression": "1",
              "permit_url": "http://169.254.169.254/permit"},
    )
    assert r.status_code == 422


def test_read_evaluate_timeout_es_504_y_cierra(tmp_path):
    c = client(tmp_path, eval_timeout_ms=50)
    sid = c.post("/sessions", json={"scope": "t"}).json()["id"]
    r = c.post(f"/sessions/{sid}/read", json={"url": "https://example.com", "expression": "nunca"})
    assert r.status_code == 504
    assert app.state.manager.get(sid).engine.page.is_closed()
