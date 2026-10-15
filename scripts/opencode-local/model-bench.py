#!/usr/bin/env python3
"""Banco de los modelos -free del serve enjaulado (127.0.0.1:4096).

Mide las dos cosas que asistenta necesita de verdad:
  1. LLEGA   - completa una llamada y con cuanto (latencia).
  2. CUMPLE  - emite el contrato de tools por prompt: un unico JSON
               {"tool": ..., "args": {...}} con la tool y el objetivo exactos.

No usa las tools builtin de opencode: el contrato va en el texto y lo ejecuta
el adaptador, asi que "responde bien" para asistenta significa literal y exacto.
"""
import json, os, re, sys, time, urllib.request

BASE = os.environ.get("OC_SERVE_URL", "http://127.0.0.1:4096")
TIMEOUT = 75

MODELS = [
    "deepseek-v4.1-flash-free",
    "space-bunny-free",
    "cat-jam-free",
    "mimo-v2.6-flash-free",
    "nemotron-3.5-lightning-free",
    "nemotron-3.5-super-vl-free",
    "nemotron-3-ultra-free",
    "muse-spark-1.3-contributor-free",
    "longcat-2.5-preview-free",
    "step-5-preview-free",
]

CHAT = "Responde exactamente y solo esto: ok"
TOOL = ('Llama a tu herramienta read sobre el fichero LEEME.txt. '
        'Responde SOLO con un JSON unico, sin texto alrededor ni markdown: '
        '{"tool":"read","args":{"filePath":"LEEME.txt"}}')


def req(method, path, body=None):
    r = urllib.request.Request(
        BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=TIMEOUT) as res:
        return json.loads(res.read())


def ask(model, text):
    """Devuelve (ok, ms, respuesta_cruda, error)."""
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
            done, err, last = False, None, ""
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
                return (err is None, int((time.time() - t0) * 1000), last.strip(), err)
            time.sleep(2)
        return (False, int((time.time() - t0) * 1000), last.strip(), "timeout %ds" % TIMEOUT)
    except Exception as e:
        return (False, int((time.time() - t0) * 1000), "", str(e)[:90])
    finally:
        try:
            req("DELETE", "/session/" + sid)
        except Exception:
            pass


def parse_contract(text):
    """El reply debe ser UN JSON con tool y args. Devuelve (ok, tool, motivo)."""
    t = text.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", t, re.S)
    if fence:
        t = fence.group(1).strip()
    m = re.search(r"\{.*\}", t, re.S)
    if not m:
        return (False, "", "sin JSON")
    try:
        o = json.loads(m.group(0))
    except Exception as e:
        return (False, "", "JSON invalido: " + str(e)[:40])
    if not isinstance(o, dict):
        return (False, "", "no es objeto")
    if o.get("tool") != "read":
        return (False, str(o.get("tool")), "tool distinta")
    args = o.get("args")
    if not isinstance(args, dict) or args.get("filePath") != "LEEME.txt":
        return (False, "read", "filePath no exacto")
    return (True, "read", "")


rows = []
print("%-34s %-7s %-9s %-7s %-7s %s" % ("modelo", "llega", "chat_ms", "cumple", "tool_ms", "nota"))
print("-" * 104)
for m in MODELS:
    ok1, ms1, txt1, err1 = ask(m, CHAT)
    ok2, ms2, txt2, err2 = (False, 0, "", "no probado")
    note = ""
    if ok1:
        ok2, ms2, txt2, err2 = ask(m, TOOL)
        if not ok2 and err2 == "timeout %ds" % TIMEOUT:
            note = "tool timeout"
    else:
        note = (err1 if isinstance(err1, str) else json.dumps(err1)[:70])[:44]

    if ok2:
        _c, tool, why = parse_contract(txt2)
        ok2, note2 = _c, (why or "JSON exacto")
        if why:
            note = note2
    print("%-34s %-7s %-9s %-7s %-7s %s" % (
        m,
        "si" if ok1 else "NO",
        ms1 if ok1 else "-",
        ("si" if ok2 else "NO"),
        ms2 if ok2 else "-",
        note))
    rows.append({"model": m, "llega": ok1, "chat_ms": ms1, "cumple": ok2, "tool_ms": ms2, "nota": note})

print()
print(json.dumps(rows, indent=1))
sys.exit(0)
