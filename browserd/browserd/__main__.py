"""Arranque: `python -m browserd` (equivalente a uvicorn browserd.server:app)."""
from __future__ import annotations

import uvicorn

from .config import Settings


def main() -> None:
    s = Settings()
    uvicorn.run("browserd.server:app", host=s.host, port=s.port, log_level="info")


if __name__ == "__main__":
    main()
