"""Tests de la barrera por request (auditoria #130)."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

from browserd.guard import PermitUrlError, RequestGuard, host_covered, validate_permit_url


def test_host_covered_dominio_y_subdominio():
    assert host_covered(["amazon.es"], "https://www.amazon.es/s?k=tv")
    assert host_covered(["amazon.es"], "https://amazon.es/")
    assert not host_covered(["amazon.es"], "https://amazon.es.evil.test/")
    assert not host_covered(["amazon.es"], "https://notamazon.es/")
    assert not host_covered(["amazon.es"], "https://localhost/")


def test_validate_permit_url_solo_loopback():
    validate_permit_url("http://127.0.0.1:9900/permit")
    validate_permit_url("http://localhost:1/x")
    for bad in ("http://169.254.169.254/meta", "https://evil.example/x", "file:///etc/passwd", "http://[::]/x"):
        with pytest.raises(PermitUrlError):
            validate_permit_url(bad)


def _route(resource_type: str, url: str):
    route = AsyncMock()
    request = AsyncMock()
    request.url = url
    request.resource_type = resource_type
    return route, request


def test_guard_sin_opciones_no_corta_nada():
    g = RequestGuard(None, None)
    assert g.allowed_hosts == []
    assert g.permit_url is None


def test_host_fuera_de_allowlist_aborta_y_marca_denied():
    g = RequestGuard(["amazon.es"], None)
    route, req = _route("script", "https://tracker.evil.test/x.js")
    asyncio.run(g.handle(route, req))
    route.abort.assert_awaited_once()
    assert g.denied


def test_documento_permitido_va_de_un_salto_y_no_sigue_redirects():
    g = RequestGuard(["amazon.es"], None)
    route, req = _route("document", "https://www.amazon.es/s?k=tv")
    resp = AsyncMock()
    resp.body = AsyncMock(return_value=b"<html>ok</html>")
    route.fetch = AsyncMock(return_value=resp)
    asyncio.run(g.handle(route, req))
    route.fetch.assert_awaited_once()
    assert route.fetch.await_args.kwargs.get("max_redirects") == 0
    route.fulfill.assert_awaited_once()
    route.continue_.assert_not_awaited()


def test_subrecurso_permitido_continua():
    g = RequestGuard(["amazon.es"], None)
    route, req = _route("xhr", "https://www.amazon.es/api/x")
    asyncio.run(g.handle(route, req))
    route.continue_.assert_awaited_once()
    route.fetch.assert_not_awaited()


def test_permit_hook_deniega_fail_closed_si_no_responde():
    # Puerto loopback casi seguro cerrado: el hook no responde -> DENEGADO.
    g = RequestGuard(None, "http://127.0.0.1:9/permit", permit_timeout_s=1.0)
    route, req = _route("document", "https://www.amazon.es/")
    asyncio.run(g.handle(route, req))
    route.abort.assert_awaited_once()
    assert g.denied
