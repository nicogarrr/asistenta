"""Ciclo de vida de sesiones de navegador.

Cada sesion es un contexto persistente de Camoufox (Firefox parcheado
anti-deteccion) con su propio directorio de perfil por `scope` (una tienda,
por ejemplo), para que cookies y huella sobrevivan entre arranques.

El lanzador real es `AsyncCamoufox`, pero SessionManager recibe una factoria
inyectable para que los tests no levanten navegadores de verdad.
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


async def _default_launcher(scope: str, profile_dir: Path, headless: bool) -> Engine:
    from camoufox.async_api import AsyncCamoufox

    cm = AsyncCamoufox(
        headless=headless,
        persistent_context=True,
        user_data_dir=str(profile_dir),
        humanize=True,
    )
    return await cm.__aenter__()  # type: ignore[return-value]


@dataclass
class Session:
    id: str
    scope: str
    engine: Engine
    page: Any = None


class SessionLimitError(RuntimeError):
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
            if len(self._sessions) >= self.max_sessions:
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
        session = self._sessions.pop(session_id, None)
        if session is None:
            raise SessionNotFoundError(session_id)
        await session.engine.close()

    async def close_all(self) -> None:
        for session_id in list(self._sessions):
            await self.close(session_id)
