"""SessionManager con engine falso: sin navegadores reales en tests."""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from browserd.sessions import (
    CamoufoxEngine,
    SessionClosingError,
    SessionLimitError,
    SessionManager,
    SessionNotFoundError,
)


class FakeEngine:
    def __init__(self, close_delay: float = 0.0, fail_close: bool = False) -> None:
        self.closed = False
        self.close_delay = close_delay
        self.fail_close = fail_close

    async def new_page(self):
        return object()

    async def close(self) -> None:
        if self.close_delay:
            await asyncio.sleep(self.close_delay)
        if self.fail_close:
            raise RuntimeError("close roto")
        self.closed = True


def make_manager(tmp_path: Path, max_sessions: int = 2, engine_factory=None) -> SessionManager:
    async def launcher(scope, profile_dir, headless):
        return engine_factory(scope) if engine_factory else FakeEngine()

    return SessionManager(profiles_dir=tmp_path, max_sessions=max_sessions, launcher=launcher)


def test_create_and_reuse_scope(tmp_path):
    m = make_manager(tmp_path)
    s1 = asyncio.run(m.create("Amazon"))
    s2 = asyncio.run(m.create("amazon"))
    assert s1.id == s2.id and s1.scope == "amazon"


def test_limit(tmp_path):
    m = make_manager(tmp_path, max_sessions=2)
    asyncio.run(m.create("a"))
    asyncio.run(m.create("b"))
    with pytest.raises(SessionLimitError):
        asyncio.run(m.create("c"))


def test_close(tmp_path):
    m = make_manager(tmp_path)
    s = asyncio.run(m.create("a"))
    asyncio.run(m.close(s.id))
    assert m.list() == []
    with pytest.raises(SessionNotFoundError):
        m.get(s.id)


def test_scope_validation(tmp_path):
    m = make_manager(tmp_path)
    with pytest.raises(ValueError):
        asyncio.run(m.create("../etc"))


def test_close_lento_no_libera_capacidad_ni_perfil(tmp_path):
    """Canario de carrera #129: close bloqueado + create concurrente."""
    engines: dict[str, FakeEngine] = {}

    async def scenario():
        m = make_manager(tmp_path, max_sessions=1,
                         engine_factory=lambda scope: engines.setdefault(scope, FakeEngine(close_delay=0.2)))
        s = await m.create("a")
        closing = asyncio.create_task(m.close(s.id))
        await asyncio.sleep(0.05)  # close en vuelo, engine aun vivo
        # Capacidad no liberada: otra sesion NO cabe
        with pytest.raises(SessionLimitError):
            await m.create("b")
        # El mismo perfil no se reabre mientras cierra
        with pytest.raises(SessionClosingError):
            await m.create("a")
        await closing
        # Tras el cierre real ya cabe otra
        s2 = await m.create("b")
        return s2

    s2 = asyncio.run(scenario())
    assert engines["a"].closed is True
    assert engines["b"].closed is False and s2.scope == "b"


def test_close_fallido_no_pierde_el_handle(tmp_path):
    async def scenario():
        m = make_manager(tmp_path, engine_factory=lambda scope: FakeEngine(fail_close=True))
        s = await m.create("a")
        with pytest.raises(RuntimeError):
            await m.close(s.id)
        return m.get(s.id)  # sigue registrado: se puede reintentar

    assert asyncio.run(scenario()).scope == "a"


def test_close_all_intenta_todas_aunque_una_falle(tmp_path):
    async def scenario():
        n = {"i": 0}
        engines = []

        def factory(scope):
            n["i"] += 1
            e = FakeEngine(fail_close=(n["i"] == 1))
            engines.append(e)
            return e

        m = make_manager(tmp_path, max_sessions=3, engine_factory=factory)
        await m.create("a")
        await m.create("b")
        await m.create("c")
        return await m.close_all(), engines

    errors, engines = asyncio.run(scenario())
    assert len(errors) == 1
    assert [e.closed for e in engines].count(True) == 2


class FakeCM:
    """Canary del context manager de camoufox (#129 bloqueante 3)."""

    def __init__(self) -> None:
        self.entered = False
        self.exited = 0

    async def __aenter__(self):
        self.entered = True
        return self

    async def __aexit__(self, *exc):
        self.exited += 1

    async def new_page(self):
        return object()

    async def close(self):
        raise RuntimeError("fallo cerrando el contexto")


def test_camoufox_engine_siempre_ejecuta_aexit():
    async def scenario():
        cm = FakeCM()
        context = await cm.__aenter__()
        engine = CamoufoxEngine(cm, context)
        with pytest.raises(RuntimeError):
            await engine.close()
        return cm.exited

    assert asyncio.run(scenario()) == 1  # __aexit__ llamado pese al fallo
