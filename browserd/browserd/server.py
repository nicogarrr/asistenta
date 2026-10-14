"""API HTTP del sidecar.

Defensas (auditoria #129):
- Host ajeno a loopback -> 403 en TODAS las rutas (frena DNS rebinding: un
  sitio web no puede apuntar un dominio a 127.0.0.1 y manejar navegadores).
- Origin ajeno a loopback -> 403 (defensa en profundidad para clientes web).
- Bind fuera de loopback exige token o el arranque falla (config.Settings).
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

from .config import Settings, is_loopback_host
from .guard import PermitUrlError, RequestGuard
from .sessions import (
    SessionClosingError,
    SessionLimitError,
    SessionManager,
    SessionNotFoundError,
)

_bearer = HTTPBearer(auto_error=False)


def _host_only(value: str) -> str:
    value = value.strip()
    if value.startswith("["):  # [::1]:7701
        return value.split("]")[0] + "]"
    return value.split(":")[0]


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


app = FastAPI(title="browserd", version="0.1.1", lifespan=_lifespan)
app.state.settings = Settings()
app.state.manager = _make_manager(app.state.settings)

@app.middleware("http")
async def loopback_guard(request: Request, call_next):
    host = _host_only(request.headers.get("host") or "")
    if not is_loopback_host(host):
        return JSONResponse(status_code=403, content={"detail": "Host no permitido"})
    origin = request.headers.get("origin")
    if origin:
        origin_host = urlsplit(origin).hostname or ""
        if not is_loopback_host(origin_host):
            return JSONResponse(status_code=403, content={"detail": "Origin no permitido"})
    return await call_next(request)


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
    # Barrera por request (auditoria #130): ambas opcionales y compatibles hacia
    # atras; con alguna activa TODA request pasa host+permit y los documentos
    # van de un salto (redirects re-entran por la barrera).
    allowed_hosts: list[str] | None = None
    permit_url: str | None = None


class ReadRequest(BaseModel):
    """Lectura atomica (#130 ronda 3): goto + evaluate + cierre de pagina.

    Sin pagina viva entre llamadas: no hay JS en idle con red libre ni service
    workers sobreviviendo a la lectura. La barrera cubre TODA la operacion.
    """
    url: str = Field(min_length=1, max_length=2000)
    expression: str = Field(min_length=1, max_length=20000)
    wait_until: str = Field(default="domcontentloaded", pattern="^(load|domcontentloaded|networkidle|commit)$")
    timeout_ms: int = Field(default=45000, ge=1000, le=120000)
    settle_ms: int = Field(default=0, ge=0, le=30000)
    allowed_hosts: list[str] | None = None
    permit_url: str | None = None


class EvalRequest(BaseModel):
    expression: str = Field(min_length=1, max_length=20000)
    timeout_ms: int | None = Field(default=None, ge=1000, le=120000)


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
    except SessionClosingError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:  # launcher roto (sin camoufox, sin display, ...): error controlado
        raise HTTPException(
            status_code=503, detail=f"motor de navegador no disponible: {type(exc).__name__}"
        ) from exc
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
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"cierre fallido (la sesion sigue registrada): {type(exc).__name__}"
        ) from exc
    return {"closed": True}


def _get_session(session_id: str):
    try:
        return app.state.manager.get(session_id)
    except SessionNotFoundError as exc:
        raise HTTPException(status_code=404, detail="sesion no encontrada") from exc


@app.post("/sessions/{session_id}/goto", dependencies=[Depends(_auth)])
async def goto(session_id: str, body: GotoRequest) -> dict[str, Any]:
    session = _get_session(session_id)
    async with session.lock:  # nada de evaluate/close pisando la navegacion
        guard: RequestGuard | None = None
        if body.allowed_hosts or body.permit_url:
            try:
                guard = RequestGuard(body.allowed_hosts, body.permit_url)
            except PermitUrlError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc
        try:
            page = session.page
            if page is None or page.is_closed():
                page = await session.engine.new_page()
                session.page = page
            if guard is not None:
                await page.route("**/*", guard.handle)
            try:
                resp = await page.goto(body.url, wait_until=body.wait_until, timeout=body.timeout_ms)
                if body.settle_ms:
                    await page.wait_for_timeout(body.settle_ms)
            finally:
                if guard is not None:
                    await page.unroute("**/*", guard.handle)
            return {
                "status": resp.status if resp else None,
                "url": page.url,
                "title": await page.title(),
                "denied": bool(guard and guard.denied),
            }
        except HTTPException:
            raise
        except Exception as exc:
            # La barrera corto la navegacion (host fuera de allowlist, robots o
            # presupuesto): NO es un fallo del sidecar, es un 403 semantico.
            if guard is not None and guard.denied:
                return {"status": 403, "url": "", "title": "", "denied": True}
            raise HTTPException(
                status_code=502, detail=f"navegacion fallida: {type(exc).__name__}"
            ) from exc


@app.post("/sessions/{session_id}/read", dependencies=[Depends(_auth)])
async def read_page(session_id: str, body: ReadRequest) -> dict[str, Any]:
    session = _get_session(session_id)
    guard: RequestGuard | None = None
    if body.allowed_hosts or body.permit_url:
        try:
            guard = RequestGuard(body.allowed_hosts, body.permit_url)
        except PermitUrlError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    async with session.lock:  # toda la operacion es atomica por sesion
        page = None
        context = None
        existing_pages: set = set()
        result: dict[str, Any] | None = None
        try:
            page = await session.engine.new_page()
            context = page.context
            # Paginas preexistentes (p.ej. la legacy de goto): NO las toca esta
            # lectura. Todo lo demas (la nuestra y los popups) se cierra al final.
            existing_pages = {p for p in context.pages if p is not page}
            # Barrera a NIVEL DE CONTEXTO (#130): los popups/ventanas que el JS
            # abra durante la lectura heredan route y barrera.
            if guard is not None:
                await context.route("**/*", guard.handle)
            resp = await page.goto(body.url, wait_until=body.wait_until, timeout=body.timeout_ms)
            if body.settle_ms:
                await page.wait_for_timeout(body.settle_ms)
            value = await asyncio.wait_for(
                page.evaluate(body.expression), timeout=app.state.settings.eval_timeout_ms / 1000
            )
            result = {
                "status": resp.status if resp else None,
                "url": page.url,
                "title": await page.title(),
                "value": value,
                "denied": bool(guard and guard.denied),
            }
        except TimeoutError:
            raise HTTPException(status_code=504, detail="evaluate agoto su timeout") from None
        except HTTPException:
            raise
        except Exception as exc:
            if guard is not None and guard.denied:
                result = {"status": 403, "url": "", "title": "", "value": None, "denied": True}
            else:
                raise HTTPException(
                    status_code=502, detail=f"lectura fallida: {type(exc).__name__}"
                ) from exc
        finally:
            # Cierra TODA pagina creada por la lectura (la principal y los
            # popups). Un fallo de cierre NO es exito silencioso (#130): la
            # sesion se descarta con el engine cerrado y la lectura falla.
            close_error: Exception | None = None
            if context is not None:
                for p in list(context.pages):
                    if p not in existing_pages:
                        try:
                            await p.close()
                        except Exception as exc:  # pragma: no cover - defensivo
                            close_error = close_error or exc
                if guard is not None:
                    try:
                        await context.unroute("**/*", guard.handle)
                    except Exception:
                        pass
            if session.page is not None and session.page is not page and page is not None:
                pass  # pagina legacy de goto: no la toca esta lectura
            elif session.page is page:
                session.page = None
            if close_error is not None:
                try:
                    await session.engine.close()
                except Exception:
                    pass
                app.state.manager.discard(session.id)
                raise HTTPException(
                    status_code=502,
                    detail=f"cierre de pagina fallido; sesion descartada: {type(close_error).__name__}",
                ) from close_error
        return result


@app.post("/sessions/{session_id}/evaluate", dependencies=[Depends(_auth)])
async def evaluate(session_id: str, body: EvalRequest) -> dict[str, Any]:
    session = _get_session(session_id)
    if session.page is None or session.page.is_closed():
        raise HTTPException(status_code=409, detail="la sesion no tiene pagina activa (haz goto antes)")
    timeout_ms = body.timeout_ms or app.state.settings.eval_timeout_ms
    async with session.lock:
        try:
            value = await asyncio.wait_for(
                session.page.evaluate(body.expression), timeout=timeout_ms / 1000
            )
        except TimeoutError:
            raise HTTPException(status_code=504, detail="evaluate agoto su timeout") from None
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(
                status_code=502, detail=f"evaluate fallido: {type(exc).__name__}"
            ) from exc
    return {"value": value}
