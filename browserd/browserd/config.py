"""Configuracion por entorno. Todo local: por defecto solo escucha en 127.0.0.1."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    host: str = field(default_factory=lambda: os.environ.get("BROWSERD_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: int(os.environ.get("BROWSERD_PORT", "7701")))
    profiles_dir: Path = field(
        default_factory=lambda: Path(os.environ.get("BROWSERD_PROFILES_DIR", "./profiles")).resolve()
    )
    max_sessions: int = field(default_factory=lambda: int(os.environ.get("BROWSERD_MAX_SESSIONS", "4")))
    # Token opcional: si se define, toda llamada (salvo /health) exige
    # `Authorization: Bearer <token>`. Pensado para cuando el puerto se exponga
    # fuera de localhost; en 127.0.0.1 puede quedar vacio.
    token: str = field(default_factory=lambda: os.environ.get("BROWSERD_TOKEN", ""))
    # Headless por defecto; BROWSERD_VISIBLE=1 para depurar con ventana.
    headless: bool = field(default_factory=lambda: os.environ.get("BROWSERD_VISIBLE", "0") != "1")
