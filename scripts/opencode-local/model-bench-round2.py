#!/usr/bin/env python3
"""Ronda 2: estabilidad del contrato + razonamiento verificable.

Solo sobre los modelos que pasaron el contrato en la ronda 1 (para asistenta el
contrato es obligatorio: sin tool call el agente no hace nada).
"""
import json, os, re, statistics, time, urllib.request

BASE = os.environ.get("OC_SERVE_URL", "http://127.0.0.1:4096")
TIMEOUT = 75

CANDIDATOS = [
    "space-bunny-free",
    "deepseek-v4.1-flash-free",
    "mimo-v2.6-flash-free",
    "cat-jam-free",
    "nemotron-3.5-super-vl-free",
    "nemotron-3.5-lightning-free",
    "longcat-2.5-preview-free",
    "step-5-preview-free",
]

TOOL = ('Llama a tu herramienta read sobre el fichero LEEME.txt. '
        'Responde SOLO con un JSON unico, sin texto alrededor ni markdown: '
        '{"tool":"read","args":{"filePath":"LEEME.txt"}}')
# Esquema mas exigente: string anidado con comillas y acentos.
TOOL_HARD = ('Responde SOLO con un JSON unico, sin markdown ni texto: '
             '{"tool":"read","args":{"filePath":"LEEME.txt",'
             '"motivo":"revisión de configuración"}}')
# Razonamiento con respuesta verificable: 3*7-5 = 16
DATO = "Si tengo 3 cajas de 7 cerillas cada una y regalo 5 cerillas, ¿cuántas cerillas me quedan? Responde solo con el numero."


def req(method, path, body=None):
    r = urllib.request.Request(
        BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=TIMEOUT) as res:
        return json.loads(res.read())


def ask(model, text):
    sid = req("POST", "/session", {})["id"]
    t0 = time.time()
    try:
        req("POST", "/session/" + sid + "/message",
            {"model": {"providerID": "opencode", "modelID": model},
             "parts": [{"type": "text", "text": text}]})
        deadline = time.time() + TIMEOUT
        last = ""
        while time.time() < deadline:
            msgs = req("GET", "/session/" + sid + "/message")
            done, err = False, None
            for m in msgs:
                info = m.get("info", {})
                if info.get("role") != "assistant":
                    continue
                for p in m.get("parts", []):
                    if p.get("type") == "text":
                        last += p.get("text", "") or ""
                if info.get("finish") and info.get("finish") != "tool-calls":
                    done = True
                if info.get("error"):
                    err = info["error"]
                    done = True
            if done:
                return (err is None, int((time.time() - t0) * 1000), last.strip())
            time.sleep(2)
        return (False, int((time.time() - t0) * 1000), last.strip())
    finally:
        try:
            req("DELETE", "/session/" + sid)
        except Exception:
            pass


def obj(text):
    t = text.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", t, re.S)
    if fence:
        t = fence.group(1).strip()
    m = re.search(r"\{.*\}", t, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


print("%-32s %-9s %-9s %-9s %-8s %-7s %s" % (
    "modelo", "contrato", "med_ms", "json_hard", "razon", "ms_total", "nota"))
print("-" * 108)

for m in CANDIDATOS:
    hits, lats = 0, []
    for _ in range(3):
        ok, ms, txt = ask(m, TOOL)
        if ok:
            o = obj(txt)
            if isinstance(o, dict) and o.get("tool") == "read" and \
               isinstance(o.get("args"), dict) and o["args"].get("filePath") == "LEEME.txt":
                hits += 1
                lats.append(ms)
    med = int(statistics.median(lats)) if lats else 0

    ok, ms_h, txt_h = ask(m, TOOL_HARD)
    hard = "NO"
    if ok:
        o = obj(txt_h)
        if isinstance(o, dict) and o.get("tool") == "read" and \
           isinstance(o.get("args"), dict) and o["args"].get("filePath") == "LEEME.txt" \
           and "revisi" in str(o["args"].get("motivo", "")).lower():
            hard = "si"

    ok, ms_d, txt_d = ask(m, DATO)
    razon = "-"
    if ok:
        nums = re.findall(r"\d+", txt_d.replace(".", " "))
        razon = "si" if "16" in nums else "no"
    total = med + ms_h + ms_d
    print("%-32s %-9s %-9s %-9s %-8s %-7s %s" % (
        m, "%d/3" % hits, med or "-", hard, razon, total, ""))
