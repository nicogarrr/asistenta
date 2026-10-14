"""API con manager inyectado: el flujo HTTP completo sin navegador real."""
from __future__ import annotations

from pathlib import Path

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
        return {"expr": expression}


class FakeEngine:
    def __init__(self):
        self.page = FakePage()

    async def new_page(self):
        return self.page

    async def close(self):
        self.page._closed = True


def client(tmp_path: Path, token: str = "") -> TestClient:
    async def launcher(scope, profile_dir, headless):
        return FakeEngine()

    app.state.settings = Settings(token=token)
    app.state.manager = SessionManager(profiles_dir=tmp_path, launcher=launcher)
    return TestClient(app)


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
