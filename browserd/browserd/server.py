"""API HTTP del sidecar. Todo en localhost; ver config.Settings para el token."""
from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

from .config import Settings
from .sessions import SessionLimitError, SessionManager, SessionNotFoundError

_bearer = HTTPBearer(auto_error=False)


def _make_manager(settings: Settings) -> SessionManager:
    return SessionManager(
        profiles_dir=settings.profiles_dir,
        max_sessions=settings.max_sessions,
        headless=settings.headless,
    )


@asynccontextmanager
async def _lifespan(app: FastAPI):
    yield
    await app.state.manager.close_all()


app = FastAPI(title="browserd", version="0.1.0", lifespan=_lifespan)
app.state.settings = Settings()
app.state.manager = _make_manager(app.state.settings)


def _auth(request: Request, cred: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> None:
    token: str = request.app.state.settings.token
    if token and (cred is None or cred.credentials != token):
        raise HTTPException(status_code=401, detail="token invalido o ausente")


class SessionCreate(BaseModel):
    scope: str = Field(min_length=1, max_length=64)


class GotoRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2000)
    wait_until: str = Field(default="domcontentloaded", pattern="^(load|domcontentloaded|networkidle|commit)$")
    timeout_ms: int = Field(default=45000, ge=1000, le=120000)
    settle_ms: int = Field(default=0, ge=0, le=30000)


class EvalRequest(BaseModel):
    expression: str = Field(min_length=1, max_length=20000)


@app.get("/health")
def health() -> dict[str, Any]:
    manager: SessionManager = app.state.manager
    return {"ok": True, "sessions": len(manager.list()), "max_sessions": manager.max_sessions}


@app.post("/sessions", status_code=201, dependencies=[Depends(_auth)])
async def create_session(body: SessionCreate) -> dict[str, str]:
    try:
        session = await app.state.manager.create(body.scope)
    except SessionLimitError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"id": session.id, "scope": session.scope}


@app.get("/sessions", dependencies=[Depends(_auth)])
def list_sessions() -> list[dict[str, str]]:
    return [{"id": s.id, "scope": s.scope} for s in app.state.manager.list()]


@app.delete("/sessions/{session_id}", dependencies=[Depends(_auth)])
async def close_session(session_id: str) -> dict[str, bool]:
    try:
        await app.state.manager.close(session_id)
    except SessionNotFoundError as exc:
        raise HTTPException(status_code=404, detail="sesion no encontrada") from exc
    return {"closed": True}


@app.post("/sessions/{session_id}/goto", dependencies=[Depends(_auth)])
async def goto(session_id: str, body: GotoRequest) -> dict[str, Any]:
    try:
        session = app.state.manager.get(session_id)
    except SessionNotFoundError as exc:
        raise HTTPException(status_code=404, detail="sesion no encontrada") from exc
    page = session.page
    if page is None or page.is_closed():
        page = await session.engine.new_page()
        session.page = page
    try:
        resp = await page.goto(body.url, wait_until=body.wait_until, timeout=body.timeout_ms)
    except Exception as exc:  # playwright TimeoutError y cia: se reportan como 502
        raise HTTPException(status_code=502, detail=f"navegacion fallida: {type(exc).__name__}") from exc
    if body.settle_ms:
        await page.wait_for_timeout(body.settle_ms)
    return {
        "status": resp.status if resp else None,
        "url": page.url,
        "title": await page.title(),
    }


@app.post("/sessions/{session_id}/evaluate", dependencies=[Depends(_auth)])
async def evaluate(session_id: str, body: EvalRequest) -> dict[str, Any]:
    try:
        session = app.state.manager.get(session_id)
    except SessionNotFoundError as exc:
        raise HTTPException(status_code=404, detail="sesion no encontrada") from exc
    if session.page is None or session.page.is_closed():
        raise HTTPException(status_code=409, detail="la sesion no tiene pagina activa (haz goto antes)")
    try:
        value = await session.page.evaluate(body.expression)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"evaluate fallido: {type(exc).__name__}") from exc
    return {"value": value}
