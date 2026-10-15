#!/usr/bin/env python3
"""Banco de VISION y computer-use para los modelos -free del serve enjaulado.

Mide la capacidad del MODELO por el camino real del serve (partes file con
data-URI), separada del adaptador de asistenta. Desde r6 el adaptador adjunta
las imagenes de los RESULTADOS (renderTranscriptWithImages en
src/core/opencode-local.ts); este banco verifica al modelo con el mismo
mecanismo, y sirve para elegir modelo de respaldo si el titular cambia.

Todo se puntua con respuesta verificable: no hay juicio humano en el veredicto.
Incluye un control NEGATIVO (cat-jam-free declara input.image=false): si el banco
no lo castiga, el banco no discrimina y no sirve. Requiere Pillow.
"""
import base64, io, json, os, re, time, unicodedata, urllib.request

from PIL import Image, ImageDraw, ImageFont

BASE = os.environ.get("OC_SERVE_URL", "http://127.0.0.1:4096")
TIMEOUT = 90

MODELOS = [
    ("space-bunny-free", True),
    ("deepseek-v4.1-flash-free", True),
    ("cat-jam-free", False),   # control: el serve declara image=false
]

# El control SI se puntua: es lo que demuestra que el banco discrimina. Sin el,
# un 8/8 en los otros dos no prueba que vieran la imagen y no acertaran por priors.
solo = os.environ.get("SOLO")
if solo:
    MODELOS = [m for m in MODELOS if solo in m[0]]


def fuente(tam):
    for ruta in (r"C:\Windows\Fonts\arialbd.ttf", r"C:\Windows\Fonts\arial.ttf",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(ruta, tam)
        except Exception:
            pass
    return ImageFont.load_default()


def png_b64(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def norm(s):
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode().lower()
    return " ".join(s.split())


def img_cuadrantes():
    img = Image.new("RGB", (640, 480), (255, 255, 255))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 319, 239], fill=(220, 40, 40))      # sup izq: rojo
    d.rectangle([320, 0, 639, 239], fill=(40, 180, 60))    # sup der: verde
    d.rectangle([0, 240, 319, 479], fill=(50, 80, 220))   # inf izq: azul
    d.rectangle([320, 240, 639, 479], fill=(240, 220, 50))  # inf der: amarillo
    return img


def img_codigo():
    img = Image.new("RGB", (640, 200), (255, 255, 255))
    d = ImageDraw.Draw(img)
    d.text((60, 50), "K7QX2", fill=(0, 0, 0), font=fuente(96))
    return img


def img_circulos():
    img = Image.new("RGB", (640, 400), (255, 255, 255))
    d = ImageDraw.Draw(img)
    for x in (90, 220, 350, 480, 560):
        d.ellipse([x - 40, 180 - 40, x + 40, 180 + 40], fill=(50, 80, 220))
    return img


def img_esquina():
    img = Image.new("RGB", (640, 480), (255, 255, 255))
    d = ImageDraw.Draw(img)
    d.rectangle([30, 390, 110, 470], fill=(220, 40, 40))   # inferior izquierda
    return img


def img_tamanos():
    img = Image.new("RGB", (640, 480), (255, 255, 255))
    d = ImageDraw.Draw(img)
    d.rectangle([40, 40, 100, 100], fill=(50, 80, 220))          # azul pequeno
    d.rectangle([400, 240, 600, 440], fill=(220, 40, 40))       # rojo grande
    return img


def img_ui():
    img = Image.new("RGB", (640, 300), (240, 240, 240))
    d = ImageDraw.Draw(img)
    etiquetas = ["ABRIR", "GUARDAR", "CERRAR"]
    f = fuente(34)
    for i, txt in enumerate(etiquetas):
        x0 = 30 + i * 200
        fill = (40, 110, 220) if txt == "GUARDAR" else (215, 215, 215)
        d.rounded_rectangle([x0, 110, x0 + 170, 190], radius=10, fill=fill,
                            outline=(60, 60, 60), width=2)
        d.text((x0 + 26, 132), txt, fill=(255, 255, 255) if txt == "GUARDAR" else (20, 20, 20), font=f)
    return img


def img_sin_triangulo():
    img = Image.new("RGB", (480, 320), (255, 255, 255))
    d = ImageDraw.Draw(img)
    d.ellipse([160, 80, 320, 240], fill=(50, 80, 220))   # solo un circulo azul
    return img


COLORES = {
    "verde": {"verde", "green"},
    "rojo": {"rojo", "red"},
    "azul": {"azul", "blue"},
}

PRUEBAS = [
    ("T1 color del cuadrante superior derecho", img_cuadrantes,
     "De que color es el cuadrante superior derecho? Responde solo con el color.",
     lambda r: bool(COLORES["verde"] & set(re.findall(r"[a-z]+", norm(r)))), "verde"),
    ("T2 OCR del codigo", img_codigo,
     "Lee el texto que aparece en la imagen. Responde solo con el texto.",
     lambda r: "k7qx2" in norm(r).replace(" ", ""), "K7QX2"),
    ("T3 contar circulos", img_circulos,
     "Cuantos circulos hay en la imagen? Responde solo con el numero.",
     lambda r: "5" in re.findall(r"\d+", norm(r)), "5"),
    ("T4 esquina del cuadrado", img_esquina,
     "En que esquina esta el cuadrado rojo: superior izquierda, superior derecha, "
     "inferior izquierda o inferior derecha? Responde solo con la esquina.",
     lambda r: ("inferior izquierda" in norm(r)) and ("superior" not in norm(r).split("inferior izquierda")[0][-25:]),
     "inferior izquierda"),
    ("T5 comparar tamanos", img_tamanos,
     "Cual de los dos cuadrados es mas grande, el azul o el rojo? Responde solo con el color.",
     lambda r: bool(COLORES["rojo"] & set(re.findall(r"[a-z]+", norm(r)))), "rojo"),
    ("T6 boton resaltado en pantalla", img_ui,
     "Mira la imagen. Que boton esta resaltado en azul? Responde solo con su texto.",
     lambda r: "guardar" in norm(r), "GUARDAR"),
    ("T7 computer use: accion anclada", img_ui,
     "Mira la imagen y decide la accion. Responde SOLO con un JSON unico, sin markdown: "
     '{"tool":"computer:click","args":{"target":"GUARDAR"}}',
     None, "GUARDAR"),
    ("T8 honestidad: objeto ausente", img_sin_triangulo,
     "De que color es el triangulo de la imagen?",
     None, "no debe inventar"),
]


def pida(modelo, prompt, imagen):
    def req(method, path, body=None):
        r = urllib.request.Request(
            BASE + path, method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(r, timeout=TIMEOUT) as res:
            return json.loads(res.read())

    sid = req("POST", "/session", {})["id"]
    t0 = time.time()
    try:
        parts = [
            {"type": "file", "mime": "image/png", "filename": "test.png",
             "url": png_b64(imagen)},
            {"type": "text", "text": prompt},
        ]
        req("POST", "/session/" + sid + "/message",
            {"model": {"providerID": "opencode", "modelID": modelo}, "parts": parts})
        deadline = time.time() + TIMEOUT
        txt = ""
        while time.time() < deadline:
            msgs = req("GET", "/session/" + sid + "/message")
            done, err = False, None
            for m in msgs:
                info = m.get("info", {})
                if info.get("role") != "assistant":
                    continue
                for p in m.get("parts", []):
                    if p.get("type") == "text":
                        txt += p.get("text", "") or ""
                if info.get("finish") and info.get("finish") != "tool-calls":
                    done = True
                if info.get("error"):
                    err = info["error"]
                    done = True
            if done:
                return (int((time.time() - t0) * 1000), txt.strip(), err)
            time.sleep(2)
        return (int((time.time() - t0) * 1000), txt.strip(), "timeout")
    finally:
        try:
            req("DELETE", "/session/" + sid)
        except Exception:
            pass


def judge_t7(r):
    t = norm(r)
    m = re.search(r"\{.*\}", t, re.S)
    if not m:
        return False
    try:
        o = json.loads(m.group(0))
    except Exception:
        return False
    return isinstance(o, dict) and o.get("tool") == "computer:click" \
        and "guardar" in json.dumps(o.get("args", {}), ensure_ascii=False).lower()


def judge_t8(r):
    t = norm(r)
    neg = ("no hay", "no existe", "no veo", "no aparece", "no contiene", "no hay ningun",
           "no se ve", "no hay ningun triangulo")
    return any(n in t for n in neg)


print("%-38s %s" % ("prueba", " ".join("%-26s" % m[0] for m in MODELOS)))
print("-" * (38 + 27 * len(MODELOS)))
sumas = {}
for nombre, mkimg, prompt, judge, esperado in PRUEBAS:
    fila = []
    for modelo, es_vis in MODELOS:
        ms, txt, err = pida(modelo, prompt, mkimg())
        if err:
            ok = False
            nota = "error"
        else:
            ok = judge(txt) if judge is not None else (
                judge_t7(txt) if nombre.startswith("T7") else judge_t8(txt))
            nota = ("OK" if ok else "FALLO")
        sumas.setdefault(modelo, [0, 0])
        sumas[modelo][1] += 1
        sumas[modelo][0] += 1 if ok else 0
        detalle = "%s %dms" % (nota, ms)
        if not ok:
            detalle += " " + norm(txt)[:70]
        fila.append(detalle)
    while len(fila) < len(MODELOS):
        fila.append("-")
    print("%-38s %s" % (nombre[:38], " ".join("%-26s" % f for f in fila)))

print()
for m, (ok, tot) in sumas.items():
    print("%-30s %d/%d" % (m, ok, tot))
