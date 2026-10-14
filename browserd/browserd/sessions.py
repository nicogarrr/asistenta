"""Ciclo de vida de sesiones de navegador.

Cada sesion es un contexto persistente de Camoufox (Firefox parcheado
anti-deteccion) con su propio directorio de perfil por `scope` (una tienda,
por ejemplo), para que cookies y huella sobrevivan entre arranques.

Concurrencia:
- Un lock global serializa create/close: la capacidad ocupada cuenta sesiones
  vivas Y en cierre, asi un close lento nunca deja hueco a una sesion de mas
  ni reabre el mismo perfil mientras el engine anterior se cierra.
- Un lock por sesion serializa goto/evaluate/close sobre SU pagina: una
  evaluate larga no se entremezcla con un goto ni con el cierre.
- Si engine.close() falla, la sesion vuelta a _sessions: el handle no se
  pierde y se puede reintentar el cierre.

El lanzador real envuelve el context manager de AsyncCamoufox para que close()
ejecute SIEMPRE __aexit__ (cierra navegador y driver de playwright); tests
inyectan una factoria falsa.
"""
from __future__ import annotations

import asyncio
import itertools
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Protocol


class Engine(Protocol):
    """Lo minimo que necesita el gestor de un contexto de navegador."""

    async def new_page(self) -> Any: ...

    async def close(self) -> None: ...


Launcher = Callable[[str, Path, bool], Awaitable[Engine]]


class CamoufoxEngine:
    """Engine real: contexto persistente + su context manager.

    Sin este adaptador el ``AsyncCamoufox.__aenter__`` suelto dejaba el driver
    de playwright vivo al cerrar: ``close`` llama siempre ``__aexit__`` en
    ``finally`` (cierra navegador Y driver aunque falle el cierre del contexto).
    """

    def __init__(self, cm: Any, context: Any) -> None:
        self._cm = cm
        self._context = context

    async def new_page(self) -> Any:
        return await self._context.new_page()

    async def close(self) -> None:
        try:
            await self._context.close()
        finally:
            await self._cm.__aexit__(None, None, None)


async def _default_launcher(scope: str, profile_dir: Path, headless: bool) -> Engine:
    from camoufox.async_api import AsyncCamoufox

    cm = AsyncCamoufox(
        headless=headless,
        persistent_context=True,
        user_data_dir=str(profile_dir),
        humanize=True,
        # El lector historico bloquea service workers; con perfil persistente
        # un SW registrado sobreviviria entre lecturas con red libre (#130).
        service_workers="block",
    )
    context = await cm.__aenter__()
    return CamoufoxEngine(cm, context)


@dataclass
class Session:
    id: str
    scope: str
    engine: Engine
    page: Any = None
    # Serializa goto/evaluate/close sobre la pagina de ESTA sesion.
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class SessionLimitError(RuntimeError):
    pass


class SessionClosingError(RuntimeError):
    pass


class SessionNotFoundError(KeyError):
    pass


@dataclass
class SessionManager:
    profiles_dir: Path
    max_sessions: int = 4
    headless: bool = True
    launcher: Launcher = _default_launcher
    _sessions: dict[str, Session] = field(default_factory=dict)
    _closing: dict[str, Session] = field(default_factory=dict)
    _counter: itertools.count = field(default_factory=lambda: itertools.count(1))
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def create(self, scope: str) -> Session:
        scope = scope.strip().lower()
        if not scope or any(ch not in "abcdefghijklmnopqrstuvwxyz0123456789-_" for ch in scope):
            raise ValueError("scope solo admite [a-z0-9_-]")
        async with self._lock:
            for s in self._sessions.values():
                if s.scope == scope:
                    return s
            if any(s.scope == scope for s in self._closing.values()):
                raise SessionClosingError(f"la sesion de {scope!r} se esta cerrando; reintenta")
            # La capacidad cuenta vivas + en cierre: un close lento no libera
            # hueco hasta que el engine esta cerrado de verdad.
            if len(self._sessions) + len(self._closing) >= self.max_sessions:
                raise SessionLimitError(f"limite de sesiones ({self.max_sessions}) alcanzado")
            profile_dir = self.profiles_dir / scope
            profile_dir.mkdir(parents=True, exist_ok=True)
            engine = await self.launcher(scope, profile_dir, self.headless)
            session = Session(id=f"s{next(self._counter)}", scope=scope, engine=engine)
            self._sessions[session.id] = session
            return session

    def get(self, session_id: str) -> Session:
        try:
            return self._sessions[session_id]
        except KeyError as exc:
            raise SessionNotFoundError(session_id) from exc

    def list(self) -> list[Session]:
        return list(self._sessions.values())

    async def close(self, session_id: str) -> None:
        async with self._lock:
            session = self._sessions.pop(session_id, None)
            if session is None:
                raise SessionNotFoundError(session_id)
            self._closing[session_id] = session
        # Fuera del lock global: el cierre puede tardar. El lock de sesion
        # espera a un goto/evaluate en curso en vez de pisarlo.
        async with session.lock:
            try:
                await session.engine.close()
            except Exception:
                # No perder el handle: vuelve a vivas para reintentar.
                async with self._lock:
                    self._closing.pop(session_id, None)
                    self._sessions[session_id] = session
                raise
            async with self._lock:
                self._closing.pop(session_id, None)

    def mark_broken(self, session: Session) -> None:
        """Sesion irrecuperable con engine posiblemente VIVO (#130 r4).

        Se mueve a _closing y NUNCA sale de ahi en este proceso: la capacidad
        queda retenida hasta un cleanup verificado (reinicio del sidecar), en
        vez de liberar hueco con un navegador fuera de la barrera.
        """
        self._sessions.pop(session.id, None)
        self._closing[session.id] = session

    def discard(self, session_id: str) -> None:
        """Borra la sesion SIN cerrar: el engine ya se cerro o esta roto.

        La usa /read cuando el cierre de pagina falla: la sesion no puede
        seguir sirviendo con una pagina viva fuera de la barrera.
        """
        self._sessions.pop(session_id, None)

    async def close_all(self) -> dict[str, str]:
        """Cierra todas; un fallo no impide cerrar las demas. Devuelve errores."""
        errors: dict[str, str] = {}
        for session_id in list(self._sessions):
            try:
                await self.close(session_id)
            except SessionNotFoundError:
                continue
            except Exception as exc:  # engine.close fallo: queda en _sessions
                errors[session_id] = f"{type(exc).__name__}: {exc}"
        return errors
