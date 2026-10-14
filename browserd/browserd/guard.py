"""Barrera de requests por navegacion (auditoria #130, hallazgo 1/5).

Opcional y compatible hacia atras: se activa solo si goto trae
``allowed_hosts`` o ``permit_url``. Con la barrera activa:

- TODA request (documento, script, xhr, fetch, recursos) debe pasar:
  1. host cubierto por ``allowed_hosts`` (host == dominio o subdominio);
  2. ``permit_url`` responde 2xx (robots/presupuesto los decide el cliente;
     si el hook no responde o falla -> DENEGADO, fail-closed).
- Los documentos se traen de UN SOLO SALTO (``route.fetch(max_redirects=0)``)
  y se devuelven tal cual: un 3xx lo sigue el navegador como una NUEVA
  request que vuelve a pasar por la barrera. Es la semantica exacta del
  lector historico de pricewatch (PublicPriceBrowser).

``permit_url`` solo admite loopback: el sidecar nunca llama a una URL externa
con datos de navegacion (SSRF).
"""
from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from .config import is_loopback_host


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
                 permit_timeout_s: float = 10.0) -> None:
        self.allowed_hosts = [d for d in (allowed_hosts or []) if d.strip()]
        self.permit_url = permit_url
        self.permit_timeout_s = permit_timeout_s
        self.denied = False  # la barrera corto alguna request de esta navegacion
        if self.permit_url:
            validate_permit_url(self.permit_url)

    async def _permit(self, url: str, resource_type: str) -> bool:
        """Fail-closed: sin hook -> permite (la barrera es la allowlist); hook roto -> niega."""
        if not self.permit_url:
            return True
        import httpx

        try:
            async with httpx.AsyncClient(timeout=self.permit_timeout_s) as client:
                resp = await client.post(self.permit_url, json={"url": url, "resource_type": resource_type})
            return 200 <= resp.status_code < 300
        except Exception:
            return False

    async def handle(self, route: Any, request: Any) -> None:
        """Handler de page.route: barrera por request + documentos de un salto."""
        url: str = request.url
        if self.allowed_hosts and not host_covered(self.allowed_hosts, url):
            self.denied = True
            await route.abort()
            return
        if not await self._permit(url, request.resource_type):
            self.denied = True
            await route.abort()
            return
        if request.resource_type == "document":
            # Un salto: un 3xx NO se sigue aqui; el navegador lo pide despues
            # como nueva request que vuelve a pasar la barrera.
            resp = await route.fetch(max_redirects=0)
            body = await resp.body()
            await route.fulfill(response=resp, body=body)
            return
        await route.continue_()
