"""Barrera de requests por navegacion (auditoria #130, rondas 1-3).

Se activa solo si la operacion trae ``allowed_hosts`` o ``permit_url``
(compatible hacia atras). Con la barrera activa replica el camino del lector
historico de pricewatch (PublicPriceBrowser):

- Tipos permitidos: document, script, xhr, fetch. El resto (imagenes, media,
  fuentes, css...) se aborta: no consumen presupuesto ni salen a la red.
- Dos fases, como el historico (#130 ronda 4):
  1. PREFLIGHT: hook {url, resource_type} ANTES de cualquier fetch: robots y
     presupuesto deciden antes de que la request salga a red (el presupuesto
     se descuenta por intento, como hace reserve() del lector historico).
     Hook caido aqui = la request NUNCA sale (fail-closed real).
  2. Fetch de UN SOLO SALTO (``route.fetch(max_redirects=0)``). OJO: el smoke
     real con Camoufox demostro que un 3xx fulfilled NO vuelve a pasar por
     page/context.route (Firefox lo sigue internamente). Por eso los redirects
     los sigue EL GUARD salto a salto (hasta 10), y cada salto pasa host +
     preflight + postflight como una request independiente.
  3. POSTFLIGHT: hook {url, resource_type, status, body}: isBlockedPage
     (challenge) se evalua con la respuesta real antes de fulfill.
- Fail-closed: hook caido, no-loopback o respuesta no-2xx -> DENEGADO.

``permit_url`` solo admite http(s) loopback (SSRF: el sidecar nunca llama
fuera con datos de navegacion).
"""
from __future__ import annotations

from typing import Any
from urllib.parse import urljoin, urlsplit

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
                 permit_timeout_s: float = 30.0, require_https: bool = True) -> None:
        self.allowed_hosts = [d for d in (allowed_hosts or []) if d.strip()]
        self.permit_url = permit_url
        self.permit_timeout_s = permit_timeout_s
        self.require_https = require_https
        self.denied = False  # la barrera corto alguna request: estado PEGAJOSO (#130 r4)
        self._preflight_lock = __import__("asyncio").Lock()  # serializa preflight (pendingPermit historico)
        if self.permit_url:
            validate_permit_url(self.permit_url)

    async def _permit(self, url: str, resource_type: str,
                      status: int | None = None, body: bytes | None = None) -> bool:
        """El hook decide (robots/presupuesto/isBlockedPage viven en el cliente).

        Sin ``status``/``body`` es PREFLIGHT (antes del fetch); con ellos,
        POSTFLIGHT (tras el fetch de un salto, antes de fulfill).
        """
        if not self.permit_url:
            return True
        import httpx

        payload: dict = {"url": url, "resource_type": resource_type}
        if status is not None:
            payload["status"] = status
            payload["body"] = (body or b"").decode("utf-8", "replace")
        try:
            async with httpx.AsyncClient(timeout=self.permit_timeout_s) as client:
                resp = await client.post(self.permit_url, json=payload)
            return 200 <= resp.status_code < 300
        except Exception:
            return False

    async def handle(self, route: Any, request: Any) -> None:
        """Handler de page.route: barrera por request, redirects salto a salto.

        denied es PEGAJOSO (#130 r4): una vez cortada la lectura (denegacion o
        challenge), TODA request posterior se aborta al instante, sin hook ni
        fetch: el historico corta el resto de la lectura y no sigue consumiendo
        presupuesto.
        """
        rtype: str = request.resource_type
        if rtype not in ALLOWED_TYPES:
            await route.abort()
            return
        if self.denied:
            await route.abort()
            return
        current: str = request.url
        for hop in range(10):
            if self.require_https and urlsplit(current).scheme != "https":
                self.denied = True
                await route.abort()
                return
            if self.allowed_hosts and not host_covered(self.allowed_hosts, current):
                self.denied = True
                await route.abort()
                return
            # PREFLIGHT serializado (pendingPermit del historico): el
            # presupuesto se descuenta en orden, nunca en paralelo (#130 r4).
            async with self._preflight_lock:
                if self.denied:
                    await route.abort()
                    return
                allowed = await self._permit(current, rtype)
            if not allowed:
                self.denied = True
                await route.abort()
                return
            if hop == 0:
                resp = await route.fetch(max_redirects=0)
            elif resp_status_keep_method:
                # 307/308: conservan metodo y cuerpo originales (#130 r4)
                resp = await route.fetch(
                    url=current, method=request.method,
                    headers=dict(request.headers), post_data=request.post_data,
                    max_redirects=0,
                )
            else:
                # 301/302/303: el navegador convierte a GET sin cuerpo
                resp = await route.fetch(url=current, method="GET", max_redirects=0)
            body = await resp.body()
            # POSTFLIGHT: isBlockedPage con la respuesta real, antes de fulfill.
            if not await self._permit(current, rtype, resp.status, body):
                self.denied = True
                await route.abort()
                return
            location = (resp.headers or {}).get("location", "")
            if 300 <= resp.status < 400 and location:
                # El navegador NO re-intercepta el salto (smoke real): lo
                # seguimos nosotros, pasando la barrera en cada salto.
                resp_status_keep_method = resp.status in (307, 308)
                current = urljoin(current, location)
                continue
            await route.fulfill(response=resp, body=body)
            return
        self.denied = True  # cadena de redirects interminable
        await route.abort()
