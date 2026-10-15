#!/usr/bin/env python3
"""Item A1b — bench FAR/FRR del clasificador "chochi" con protocolo
leave-one-clip-out (LOCO): ningun dato del clip evaluado entra en su modelo.

Por cada clip de evaluacion T (habla real con la palabra en instantes
conocidos, verificados por transcripcion):

  1. Entrena un modelo con wakeword-train.py sobre: caches de entrenamiento
     (menos las ventanas de T) + ventanas de los segmentos reales aumentados
     de /realpos (menos los del grupo de T).
  2. Puntua T en streaming (misma extraccion que wakeword-windows.py:
     ventanas de 16 embeddings reales, primera en el push 25).
  3. Deteccion (FRR): para cada region positiva (push central +- una ventana
     de tolerancia) exige al menos un score >= umbral.
  4. FAR: TODAS las ventanas fuera de regiones son negativos honestos; una
     falsa alarma es una racha de >= PACIENCIA ventanas consecutivas >=
     umbral (la paciencia es el parametro operativo del listener: cuantos
     scores seguidos exige antes de despertar).

Umbral: percentil 1 de los positivos de entrenamiento de ese modelo (la regla
del spike; se imprime para comparar). El bench NO elige el umbral de
produccion: reporta el paisaje completo (hits, falsas alarmas, umbrales) para
que la decision de adopcion contra el baseline whisper-fonetico sea medida,
no opinada.

Uso:
  wakeword-farfrr-bench.py --models DIR --cache train.npz --realpos DIR \
      --eval nico1:n1:nico1.pcm:231,275,394,469 \
      --eval nico2:n2:nico2.pcm:9,21,34,46,90,141

  --eval TAG:SEGPFX:PCM:REGIONES  tag del clip, prefijo de sus segmentos en
  --realpos (se excluyen al entrenar su modelo), ruta al pcm int16 16 kHz y
  pushes centrales de las regiones positivas separados por comas.
"""
import argparse
import importlib.util
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.dont_write_bytecode = True  # el repo se monta en contenedores: nada de __pycache__
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("wakeword_windows", HERE / "wakeword-windows.py")
ww = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ww)

EMB_WINDOW = 16
REGION_TOL = EMB_WINDOW + 10  # pushes de tolerancia alrededor del centro
PATIENCE = 2  # racha minima de scores >= umbral para contar (falsa) alarma


def train_model(caches: list[str], realpos: str, exclude_tag: str, exclude_pfx: str, models: str, workdir: str) -> tuple[object, float]:
    """Entrena (via wakeword-train.py, sin atajos) excluyendo el clip evaluado."""
    import onnxruntime as ort

    # cache temporal con los segmentos reales aumentados de otros grupos
    segs = sorted(Path(realpos).glob("*.pcm"))
    clips = [f"real-{s.stem}:1:{s}" for s in segs if not s.stem.startswith(exclude_pfx)]
    if not clips:
        raise SystemExit(f"sin segmentos reales tras excluir {exclude_pfx}")
    real_cache = str(Path(workdir) / f"real-{exclude_tag}.npz")
    subprocess.run(
        [sys.executable, str(HERE / "wakeword-windows.py"), "--models", models, "--out", real_cache]
        + [arg for c in clips for arg in ("--clip", c)],
        check=True,
        capture_output=True,
    )
    out = str(Path(workdir) / f"model-{exclude_tag}.onnx")
    subprocess.run(
        [sys.executable, str(HERE / "wakeword-train.py"), "--exclude-tag-prefix", exclude_tag, "--out", out]
        + [arg for c in [*caches, real_cache] for arg in ("--cache", c)],
        check=True,
        capture_output=True,
    )
    sess = ort.InferenceSession(out, providers=["CPUExecutionProvider"])
    # umbral referencia: p1 de los positivos de entrenamiento de ESTE modelo
    xs, ys = [], []
    for path in [*caches, real_cache]:
        z = np.load(path)
        keep = np.array([not t.startswith(exclude_tag) for t in z["tags"]])
        xs.append(z["X"][keep])
        ys.append(z["y"][keep])
    X = np.vstack(xs)
    y = np.concatenate(ys)
    inp = sess.get_inputs()[0].name
    scores = sess.run(None, {inp: X.reshape(-1, EMB_WINDOW, 96).astype(np.float32)})[0].squeeze(1)
    pos = np.sort(scores[y == 1])
    thr = float(pos[max(0, int(len(pos) * 0.01) - 1)])
    return sess, thr


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--models", required=True, help="dir con melspectrogram.onnx y embedding_model.onnx")
    ap.add_argument("--cache", action="append", required=True, help="cache de entrenamiento (.npz)")
    ap.add_argument("--realpos", required=True, help="dir con segmentos reales aumentados (*.pcm)")
    ap.add_argument("--eval", action="append", required=True, metavar="TAG:SEGPFX:PCM:R1,R2,...", help="clip de evaluacion LOCO")
    args = ap.parse_args()

    with tempfile.TemporaryDirectory() as workdir:
        for spec_arg in args.eval:
            tag, pfx, pcm, regions = spec_arg.split(":", 3)
            centers = [int(r) for r in regions.split(",")]
            sess, thr = train_model(args.cache, args.realpos, tag, pfx, args.models, workdir)
            embs = ww.embeddings_of(pcm, args.models)
            W, ends = ww.windows_of(embs)
            inp = sess.get_inputs()[0].name
            s = sess.run(None, {inp: W.reshape(-1, EMB_WINDOW, 96).astype(np.float32)})[0].squeeze(1)

            hits, misses = [], []
            in_region = np.zeros(len(ends), dtype=bool)
            for cp in centers:
                reg = (ends >= cp - REGION_TOL) & (ends <= cp + REGION_TOL)
                in_region |= reg
                mx = float(s[reg].max()) if reg.any() else float("nan")
                (hits if mx >= thr else misses).append(f"{cp}({mx:.2f})")

            neg = s[~in_region]
            on = neg >= thr
            wakes, run = [], 0
            for v in on:
                run = run + 1 if v else 0
                if run == PATIENCE:
                    wakes.append(1)
            far_windows = float(on.mean()) if len(on) else 0.0
            print(
                f"[LOCO {tag}] thr={thr:.3f} | deteccion {len(hits)}/{len(centers)} "
                f"({' '.join(hits)}{' MISS:' + ' '.join(misses) if misses else ''}) | "
                f"falsos wakes (paciencia {PATIENCE}): {len(wakes)} | "
                f"FAR ventana fuera de region: {far_windows:.4f} sobre {len(neg)}"
            )


if __name__ == "__main__":
    main()
