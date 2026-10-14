"""Barrera de requests por navegacion (auditoria #130, rondas 1-3).

Se activa solo si la operacion trae ``allowed_hosts`` o ``permit_url``
(compatible hacia atras). Con la barrera activa replica el camino del lector
historico de pricewatch (PublicPriceBrowser):

- Tipos permitidos: document, script, xhr, fetch. El resto (imagenes, media,
  fuentes, css...) se aborta: no consumen presupuesto ni salen a la red.
- Toda request permitida pasa: host cubierto por ``allowed_hosts`` -> fetch
  de UN SOLO SALTO (``route.fetch(max_redirects=0)``; un 3xx lo sigue el
  navegador como NUEVA request que re-entra por la barrera) -> inspeccion en
  el hook ``permit_url`` con {url, resource_type, status, body}: el cliente
  decide con robots/presupuesto e isBlockedPage (challenge -> denied).
- Fail-closed: hook caido, no-loopback o respuesta no-2xx -> DENEGADO.

``permit_url`` solo admite http(s) loopback (SSRF: el sidecar nunca llama
fuera con datos de navegacion).
"""
from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from .config import is_loopback_host

ALLOWED_TYPES = frozenset({"document", "script", "xhr", "fetch"})


class PermitUrlError(ValueError):
    pass


def host_covered(domains: list[str], url: str) -> bool:
    host = (urlsplit(url).hostname or "").lower()
    if not host:
        return False
    for domain in domains:
        d = domain.strip().lower().lstrip(".")
        if d and (host == d or host.endswith("." + d)):
            return True
    return False


def validate_permit_url(url: str) -> None:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not is_loopback_host(parts.hostname or ""):
        raise PermitUrlError("permit_url debe ser http(s) loopback")


class RequestGuard:
    def __init__(self, allowed_hosts: list[str] | None, permit_url: str | None,
                 permit_timeout_s: float = 30.0) -> None:
        self.allowed_hosts = [d for d in (allowed_hosts or []) if d.strip()]
        self.permit_url = permit_url
        self.permit_timeout_s = permit_timeout_s
        self.denied = False  # la barrera corto alguna request de esta navegacion
        if self.permit_url:
            validate_permit_url(self.permit_url)

    async def _permit(self, url: str, resource_type: str, status: int, body: bytes) -> bool:
        """El hook decide (robots/presupuesto/isBlockedPage viven en el cliente)."""
        if not self.permit_url:
            return True
        import httpx

        try:
            async with httpx.AsyncClient(timeout=self.permit_timeout_s) as client:
                resp = await client.post(
                    self.permit_url,
                    json={
                        "url": url,
                        "resource_type": resource_type,
                        "status": status,
                        "body": body.decode("utf-8", "replace"),
                    },
                )
            return 200 <= resp.status_code < 300
        except Exception:
            return False

    async def handle(self, route: Any, request: Any) -> None:
        """Handler de page.route: barrera por request, todo de un salto."""
        url: str = request.url
        rtype: str = request.resource_type
        if rtype not in ALLOWED_TYPES:
            await route.abort()
            return
        if self.allowed_hosts and not host_covered(self.allowed_hosts, url):
            self.denied = True
            await route.abort()
            return
        resp = await route.fetch(max_redirects=0)
        body = await resp.body()
        if not await self._permit(url, rtype, resp.status, body):
            self.denied = True
            await route.abort()
            return
        await route.fulfill(response=resp, body=body)
