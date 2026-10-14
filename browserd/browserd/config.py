"""Configuracion por entorno. Todo local: por defecto solo escucha en 127.0.0.1.

Regla dura: escuchar fuera de loopback EXIGE BROWSERD_TOKEN (sin token el
arranque falla), porque la API de control mueve navegadores con perfiles y
cookies del usuario.
"""
from __future__ import annotations

import ipaddress
import os
from dataclasses import dataclass, field
from pathlib import Path

LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1", "[::1]"}


def is_loopback_host(host: str) -> bool:
    host = host.strip().lower().strip("[]")
    if host in {"localhost", "::1"}:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


@dataclass(frozen=True)
class Settings:
    host: str = field(default_factory=lambda: os.environ.get("BROWSERD_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: int(os.environ.get("BROWSERD_PORT", "7701")))
    profiles_dir: Path = field(
        default_factory=lambda: Path(os.environ.get("BROWSERD_PROFILES_DIR", "./profiles")).resolve()
    )
    max_sessions: int = field(default_factory=lambda: int(os.environ.get("BROWSERD_MAX_SESSIONS", "4")))
    # Token bearer: OPCIONAL solo en loopback; obligatorio si se sale de el.
    token: str = field(default_factory=lambda: os.environ.get("BROWSERD_TOKEN", ""))
    # Headless por defecto; BROWSERD_VISIBLE=1 para depurar con ventana.
    headless: bool = field(default_factory=lambda: os.environ.get("BROWSERD_VISIBLE", "0") != "1")
    # Timeout propio de evaluate: una Promise que nunca resuelve no puede
    # ocupar la peticion para siempre.
    eval_timeout_ms: int = field(
        default_factory=lambda: int(os.environ.get("BROWSERD_EVAL_TIMEOUT_MS", "30000"))
    )

    def __post_init__(self) -> None:
        if not is_loopback_host(self.host) and not self.token:
            raise ValueError(
                "BROWSERD_HOST fuera de loopback exige BROWSERD_TOKEN: "
                "la API de control no puede quedar abierta en red"
            )
