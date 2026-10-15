#!/usr/bin/env python3
"""Item A1b — construye la cache de ventanas de embeddings para entrenar el
clasificador de palabra propio ("chochi").

Replica el camino oficial openWakeWord v0.5.1 (openwakeword/utils.py,
AudioFeatures, verificado linea a linea):

  pcm int16 16 kHz -> pushes de 1280 muestras (80 ms) -> melspectrogram.onnx
  sobre las ultimas 1760 muestras (1280 nuevas + lookback 480; el primer push
  no tiene lookback: 1280 -> 5 frames mel, el resto 8) -> spec/10 + 2 ->
  ventana deslizante de 76 frames mel -> embedding_model.onnx -> vector de
  96 -> ventana deslizante de 16 embeddings -> una fila de 1536 floats.

Tres detalles oficiales que esta extraccion respeta (utils.py v0.5.1):

  1. feature_buffer se recorta a 120 filas (feature_buffer_max_len) y la fila
     NUEVA de cada push es SIEMPRE la ultima (fb[-1]). Indexar por posicion
     acumulada corrompe cualquier clip de mas de ~6.3 s (medido en el spike).
  2. El AudioFeatures oficial emite UN embedding por push desde el primer
     push (su melspectrogram_buffer nace relleno con 76 filas de unos), asi
     que E[j] corresponde al push j+1.
  3. Esos primeros embeddings mezclan frames de unos de relleno con audio
     real. El runner TS (src/voice/wakeword-oww.ts) arranca VACIO y solo
     puntua cuando tiene 16 embeddings reales (primer score en el push 25:
     el mel real llena la ventana de 76 en el push 10 y 16 embeddings se
     completan en el 25). Para entrenar con las mismas entradas que vera el
     runner en produccion, esta cache solo emite ventanas de 16 embeddings
     TODOS reales: E[9] es el primer embedding sin relleno (push 10) y la
     primera ventana valida termina en el push 25, como en el runner.

Etiquetado y PROCEDENCIA (objecion 3 de la auditoria, ronda 1 #139):

  Cada clip de entrada es INTEGRAMENTE positivo (la palabra suena en todo el
  clip: segmento recortado o sintesis) o INTEGRAMENTE negativo. Ademas cada
  clip declara un SOURCE: el identificador de su procedencia original (p.ej.
  "nico1" para un segmento extraido de nico1.pcm y para TODOS sus aumentos,
  "piper-gen3" para sintesis). La cache guarda el source de cada ventana y un
  manifiesto JSON con sha256 por clip, de modo que la exclusion leave-one-out
  del bench es por procedencia verificable (cubre aumentos) y no por nombre.

  Validaciones de etiquetado (objecion 4): un clip POSITIVO mas corto que el
  minimo de una ventana (MIN_POS_SAMPLES, 2.0s) se RELLENA CON CEROS al final
  hasta el minimo y el relleno queda declarado en el manifiesto
  (padded_seconds): la ventana resultante contiene la palabra entera seguida
  de silencio, un caso real (alguien dice la palabra y para); sin relleno la
  mitad de las variantes aumentadas a tempo alto quedarian fuera y el modelo
  perderia justo las pronunciaciones rapidas. Si tras el relleno un positivo
  aun no produce ventanas, es un error (etiquetaria nada como palabra). Un
  clip positivo de mas de MAX_POS_SECONDS segundos genera aviso: las ventanas
  se emiten desde el segundo 2 y un clip largo mete relleno sin la palabra
  con etiqueta 1 (heuristica declarada, no prueba de contenido).

Uso:
  wakeword-windows.py --models DIR --out cache.npz \
      --clip TAG:1:positivo.pcm:nico1 --clip TAG:0:negativo.pcm:quijote-gen4 ...

Salida .npz:
  X       [N,1536] float32  ventana aplanada (16 x 96)
  y       [N]     int8      1 = clip positivo, 0 = clip negativo
  tags    [N]     str       tag del clip de origen
  sources [N]     str       procedencia declarada del clip (para exclusion LOCO)
  pushes  [N]     int32     push en el que TERMINA la ventana (>= 25)
  manifest_json   str       JSON: por clip {tag, etiqueta, sha256, source,
                          ventanas}; por source {clips, ventanas, sha256[]}

Dependencias: numpy + openwakeword 0.5.1 (onnx). Modelos: melspectrogram.onnx
y embedding_model.onnx del release oficial v0.5.1 (Apache-2.0).
"""
import argparse
import hashlib
import json

import numpy as np
from openwakeword.utils import AudioFeatures

PUSH = 1280  # muestras por push (80 ms a 16 kHz), fijado por oww
EMB_WINDOW = 16  # embeddings por ventana del clasificador
FIRST_REAL_EMB = 9  # E[9] = push 10 = primer embedding sin relleno de unos
MAX_POS_SECONDS = 4.0  # aviso de padding si un clip positivo es mas largo
MIN_POS_SAMPLES = 32_000  # 2.0s: minimo para UNA ventana de 16 embeddings reales


def embeddings_of(pcm: "str | np.ndarray", models: str) -> np.ndarray:
    """Devuelve E[j] = embedding producido por el push j+1 (E[0] = push 1).

    pcm: ruta a un int16 16 kHz mono o el array de muestras ya cargado (p.ej.
    tras rellenar un positivo corto con ceros: el relleno debe pasar por el
    modelo, no quedarse en memoria mientras se relee el fichero).

    La fila nueva tras cada push es siempre fb[-1] (el buffer se recorta a
    120 filas; la ultima fila es siempre la mas reciente). La semilla fija el
    relleno aleatorio con el que AudioFeatures inicializa feature_buffer, por
    reproducibilidad; esas filas de relleno nunca entran en E (solo anaden
    historia anterior al primer push).
    """
    np.random.seed(0)
    af = AudioFeatures(
        inference_framework="onnx",
        melspec_model_path=f"{models}/melspectrogram.onnx",
        embedding_model_path=f"{models}/embedding_model.onnx",
    )
    x = np.fromfile(pcm, dtype=np.int16) if isinstance(pcm, str) else pcm
    n = len(x) // PUSH
    embs = []
    for p in range(n):
        af(x[p * PUSH : (p + 1) * PUSH])
        embs.append(np.asarray(af.feature_buffer)[-1].copy())
    return np.array(embs, dtype=np.float32)


def windows_of(embs: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Ventanas de 16 embeddings TODOS reales; X [M,1536], pushes de fin [M].

    La primera ventana valida cubre E[9..24] y termina en el push 25, el mismo
    punto en que el runner TS emite su primer score.
    """
    xs, ends = [], []
    for j in range(FIRST_REAL_EMB + EMB_WINDOW - 1, len(embs)):
        xs.append(embs[j - EMB_WINDOW + 1 : j + 1].flatten())
        ends.append(j + 1)  # E[j] = push j+1
    if not xs:
        return np.zeros((0, EMB_WINDOW * 96), dtype=np.float32), np.zeros(0, dtype=np.int32)
    return np.array(xs, dtype=np.float32), np.array(ends, dtype=np.int32)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--models", required=True, help="dir con melspectrogram.onnx y embedding_model.onnx")
    ap.add_argument("--out", required=True, help="ruta del .npz de salida")
    ap.add_argument(
        "--clip",
        action="append",
        required=True,
        metavar="TAG:0|1:PCM:SOURCE",
        help="clip int16 16 kHz mono; 1 = la palabra suena en todo el clip, 0 = no suena; "
        "SOURCE = procedencia original (compartida por todos los aumentos de una misma fuente)",
    )
    args = ap.parse_args()

    xs_all, y_all, tags_all, pushes_all, sources_all = [], [], [], [], []
    manifest_clips = []
    for spec in args.clip:
        parts = spec.split(":")
        if len(parts) != 4:
            raise SystemExit(f"--clip {spec!r} debe ser TAG:0|1:PCM:SOURCE")
        tag, label, path, source = parts
        if label not in ("0", "1"):
            raise SystemExit(f"etiqueta invalida en --clip {spec!r}: debe ser 0 o 1")
        raw = open(path, "rb").read()
        sha = hashlib.sha256(raw).hexdigest()
        seconds = len(raw) / 2 / 16_000
        padded_seconds = 0.0
        samples = np.frombuffer(raw, dtype=np.int16).copy()
        if label == "1" and len(samples) < MIN_POS_SAMPLES:
            padded_seconds = (MIN_POS_SAMPLES - len(samples)) / 16_000
            samples = np.concatenate([samples, np.zeros(MIN_POS_SAMPLES - len(samples), dtype=np.int16)])
        if label == "1" and seconds > MAX_POS_SECONDS:
            print(
                f"[windows] AVISO {tag}: clip positivo de {seconds:.1f}s (> {MAX_POS_SECONDS}s); "
                "las ventanas empiezan en el segundo 2 y el relleno posterior hereda etiqueta 1"
            )
        embs = embeddings_of(samples, args.models)
        xs, ends = windows_of(embs)
        if len(xs) == 0:
            if label == "1":
                raise SystemExit(
                    f"clip POSITIVO {tag} ({seconds:.1f}s, relleno {padded_seconds:.2f}s) no produce "
                    "ninguna ventana ni rellenado al minimo: etiquetarlo seria inventar datos"
                )
            print(f"[windows] {tag}: clip negativo demasiado corto, 0 ventanas (omitido)")
            continue
        xs_all.append(xs)
        y_all.append(np.full(len(xs), int(label), dtype=np.int8))
        tags_all.append(np.array([tag] * len(xs)))
        pushes_all.append(ends)
        sources_all.append(np.array([source] * len(xs)))
        manifest_clips.append(
            {"tag": tag, "label": int(label), "sha256": sha, "source": source,
             "seconds": round(seconds, 3), "padded_seconds": round(padded_seconds, 3),
             "windows": int(len(xs))}
        )
        print(f"[windows] {tag}: {len(xs)} ventanas (etiqueta {label}, source {source})")

    if not xs_all:
        raise SystemExit("ningun clip produjo ventanas")
    sources: dict[str, dict] = {}
    for c in manifest_clips:
        s = sources.setdefault(c["source"], {"clips": 0, "windows": 0, "sha256": []})
        s["clips"] += 1
        s["windows"] += c["windows"]
        s["sha256"].append(c["sha256"])
    manifest = json.dumps({"clips": manifest_clips, "sources": sources}, ensure_ascii=False, sort_keys=True)
    np.savez(
        args.out,
        X=np.vstack(xs_all),
        y=np.concatenate(y_all),
        tags=np.concatenate(tags_all),
        sources=np.concatenate(sources_all),
        pushes=np.concatenate(pushes_all),
        manifest_json=np.array(manifest),
    )
    print(f"[windows] cache escrita en {args.out}: {sum(len(x) for x in xs_all)} ventanas, "
          f"{len(manifest_clips)} clips, {len(sources)} fuentes")


if __name__ == "__main__":
    main()
