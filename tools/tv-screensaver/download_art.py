#!/usr/bin/env python3
"""Descarga obras de dominio publico (CC0) en alta resolucion y las deja en 4K (max 3840x2160).
Fuentes: Met Museum (API v1.1, sin clave), Rijksmuseum (Linked Art + IIIF, sin clave).
Uso (PC Windows):  pip install pillow   &&   python download_art.py [--out art] [--per-source 40]
Solo libreria estandar + Pillow. No toca la TV."""
import argparse, io, json, os, re, sys, time, urllib.parse, urllib.request
from PIL import Image

UA = {"User-Agent": "nico-art-screensaver/1.0"}
MIN_EDGE = 2400      # lado largo minimo de la fuente; si es menor se descarta
MAX_W, MAX_H = 3840, 2160
MAX_BYTES = 40_000_000

def get(url, accept=None):
    h = dict(UA)
    if accept: h["Accept"] = accept
    with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=60) as r:
        return r.read()

def getj(url, accept=None):
    return json.loads(get(url, accept))

def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:60] or "obra"

def save(img_bytes, name, out):
    if len(img_bytes) > MAX_BYTES: return False
    img = Image.open(io.BytesIO(img_bytes)); img.load()
    if max(img.size) < MIN_EDGE: return False
    img = img.convert("RGB")
    img.thumbnail((MAX_W, MAX_H), Image.LANCZOS)   # nunca amplia
    img.save(os.path.join(out, name + ".jpg"), "JPEG", quality=90)
    return True

def met(queries, n, out):
    got = 0
    for q in queries:
        url = "https://collectionapi.metmuseum.org/public/collection/v1.1/search?" + urllib.parse.urlencode(
            {"hasImages": "true", "isPublicDomain": "true", "q": q, "limit": 100})
        ids = getj(url).get("objectIDs") or []
        for oid in ids:
            if got >= n: return
            try:
                o = getj(f"https://collectionapi.metmuseum.org/public/collection/v1/objects/{oid}")
                if not (o.get("isPublicDomain") and o.get("primaryImage")): continue
                if o.get("classification") and "Paintings" not in o["classification"]: continue
                name = f"met-{oid}-{slug(o.get('artistDisplayName',''))}-{slug(o['title'])}"
                if os.path.exists(os.path.join(out, name + ".jpg")): got += 1; continue
                if save(get(o["primaryImage"]), name, out):
                    got += 1; print("OK met", name)
                time.sleep(0.3)
            except Exception as e:
                print("skip met", oid, e, file=sys.stderr)

def rijks(creators, n, out):
    got = 0
    for c in creators:
        url = "https://data.rijksmuseum.nl/search/collection?" + urllib.parse.urlencode(
            {"creator": c, "imageAvailable": "true", "type": "painting"})
        try: page = getj(url, "application/json")
        except Exception as e: print("rijks search fail", c, e, file=sys.stderr); continue
        for it in page.get("orderedItems", []):
            if got >= n: return
            try:
                o = getj(it["id"], "application/ld+json")
                title = next((x["content"] for x in o.get("identified_by", []) if x.get("type") == "Name"), "obra")
                v = getj(o["shows"][0]["id"], "application/ld+json")
                d = getj(v["digitally_shown_by"][0]["id"], "application/ld+json")
                iiif = d["access_point"][0]["id"]   # .../full/max/0/default.jpg
                name = f"rijks-{it['id'].rsplit('/',1)[-1]}-{slug(c)}-{slug(title)}"
                if os.path.exists(os.path.join(out, name + ".jpg")): got += 1; continue
                # pedir ya a 3840 de ancho maximo para no bajar archivos gigantes
                small = iiif.replace("/full/max/", f"/full/!{MAX_W},{MAX_H}/")
                if save(get(small), name, out):
                    got += 1; print("OK rijks", name)
                time.sleep(0.3)
            except Exception as e:
                print("skip rijks", it.get("id"), e, file=sys.stderr)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="art"); ap.add_argument("--per-source", type=int, default=40)
    a = ap.parse_args(); os.makedirs(a.out, exist_ok=True)
    met(["Van Gogh", "Monet", "Cezanne", "Seurat", "Hokusai landscape", "Turner"], a.per_source, a.out)
    rijks(["Gogh", "Vermeer", "Rembrandt", "Hobbema", "Ruisdael"], a.per_source, a.out)
    # Museo Van Gogh: no tiene API abierta; su scraper (gist RyanEager) queda como extra manual, ver RUNBOOK.
    files = sorted(f for f in os.listdir(a.out) if f.lower().endswith(".jpg"))
    print(f"\n{len(files)} imagenes en {a.out}/ ({sum(os.path.getsize(os.path.join(a.out,f)) for f in files)//1e6:.0f} MB)")
