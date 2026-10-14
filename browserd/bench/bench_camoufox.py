#!/usr/bin/env python3
"""Bateria anti-bot de un comando, pensada para el PC (Windows incluido):

    python -m bench.bench_camoufox            (o: python bench/bench_camoufox.py)

Visita los targets de bench/targets.json con Camoufox (perfil temporal en
bench/_profile), clasifica cada respuesta con la MISMA logica que asistenta
(classifyChallenge de src/browser/service.ts) y guarda bench/results.json.
Una celda ok = la tienda se abrio sin challenge ni bloqueo.
"""
from __future__ import annotations

import asyncio
import json
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent

TITLE = re.compile(
    r"^\s*(?:just a moment|un momento|un instante|attention required|verifying you are human"
    r"|checking your browser|security check|comprobaci[oó]n de seguridad)\s*"
    r"(?:\.{2,}|…|!)?\s*(?:\|\s*cloudflare)?\s*$",
    re.I,
)
TEXT = re.compile(
    r"verify you are human|verifying you are human|verifica que eres (?:un )?humano"
    r"|are you a robot|i'?m not a robot|no soy un robot|press (?:&|and) hold"
    r"|unusual traffic|tr[aá]fico inusual|complete the security check"
    r"|checking if the site connection is secure",
    re.I,
)
HTML_RE = re.compile(
    r"validateCaptcha|Introduce los caracteres|Enter the characters you see"
    r"|cf-chl-|Just a moment\.\.\.|px-captcha|triggerInterstitialChallenge"
    r"|bm-verify|captcha-delivery\.com|geo\.captcha-delivery|Incapsula incident|datadome",
    re.I,
)


def classify(status: int | None, title: str, text: str, html: str) -> tuple[str, str | None]:
    if TITLE.search((title or "").strip()):
        return "challenge", "cloudflare-ish"
    if text and len(text) < 800 and TEXT.search(text[:3000]):
        return "challenge", "verify-human"
    if status in (403, 429, 503):
        return "blocked", f"http-{status}"
    if html and HTML_RE.search(html[:200000]):
        return "blocked", "marker"
    return "ok", None


async def main() -> int:
    from camoufox.async_api import AsyncCamoufox

    targets = json.loads((HERE / "targets.json").read_text(encoding="utf-8"))
    out = {"started": time.strftime("%Y-%m-%dT%H:%M:%S"), "cells": []}
    profile = HERE / "_profile"
    profile.mkdir(exist_ok=True)
    async with AsyncCamoufox(headless=True, persistent_context=True, user_data_dir=str(profile)) as browser:
        page = await browser.new_page()
        for t in targets:
            cell = {"target": t["id"], "url": t["url"]}
            try:
                t0 = time.time()
                resp = await page.goto(t["url"], wait_until="domcontentloaded", timeout=45000)
                await page.wait_for_timeout(5000)
                status = resp.status if resp else 0
                title = await page.title()
                text = await page.evaluate("document.body ? document.body.innerText : ''") or ""
                html = await page.content()
                verdict, kind = classify(status, title, text, html)
                cell.update(status=status, title=title[:120], ms=int((time.time() - t0) * 1000),
                            verdict=verdict, kind=kind)
            except Exception as e:  # red caida, timeout, etc.
                cell.update(status=-1, verdict="error", kind=repr(e)[:160])
            out["cells"].append(cell)
            print(f"{t['id']:<16} {cell.get('verdict'):<10} {cell.get('kind') or ''}", flush=True)
            await asyncio.sleep(10)  # espaciado cortes entre dominios
    (HERE / "results.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    ok = sum(1 for c in out["cells"] if c.get("verdict") == "ok")
    print(f"\n{ok}/{len(out['cells'])} ok. Detalle en bench/results.json")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
