"""SessionManager con engine falso: sin navegadores reales en tests."""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from browserd.sessions import SessionLimitError, SessionManager, SessionNotFoundError


class FakeEngine:
    def __init__(self) -> None:
        self.closed = False

    async def new_page(self):
        return object()

    async def close(self) -> None:
        self.closed = True


def make_manager(tmp_path: Path, max_sessions: int = 2) -> SessionManager:
    created: list[FakeEngine] = []

    async def launcher(scope, profile_dir, headless):
        engine = FakeEngine()
        created.append(engine)
        return engine

    m = SessionManager(profiles_dir=tmp_path, max_sessions=max_sessions, launcher=launcher)
    m._test_created = created  # type: ignore[attr-defined]
    return m


def test_create_and_reuse_scope(tmp_path):
    m = make_manager(tmp_path)
    s1 = asyncio.run(m.create("Amazon"))
    s2 = asyncio.run(m.create("amazon"))
    assert s1.id == s2.id and s1.scope == "amazon"
    assert len(m._test_created) == 1  # type: ignore[attr-defined]


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
