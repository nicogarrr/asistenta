#!/usr/bin/env python3
"""Item A1b — bench FAR/FRR del clasificador "chochi" con protocolo
leave-one-source-out: ningun dato cuya PROCEDENCIA sea el clip evaluado entra
en su modelo (objecion 3, ronda 1 #139: exclusion por source verificable del
manifest, que cubre aumentos, no por prefijo de nombre).

REGLA UNICA DE EVENTOS (objeciones 1 y 2): positivos y negativos se juzgan
con el MISMO criterio operativo, el que aplicara el listener: un EVENTO es
una racha de >= PACIENCIA ventanas CONSECUTIVAS del timeline completo con
score >= umbral (rearme: la racha termina al caer bajo el umbral). Sobre los
eventos, no sobre picos:

  - Deteccion: cada region positiva (centro +- REGION_TOL pushes) necesita un
    evento asignado. Cada evento se asigna COMO MUCHO a una region (la de
    centro mas cercano entre las solapadas; se reporta la ambiguedad), asi un
    unico evento no puede puntuar dos veces aunque las regiones se solapen.
  - Warmup: una region cuyo centro cae antes del primer push punctuable (25,
    el primer score del runner) NO es evaluable: se reporta aparte y no entra
    ni en el numerador ni en el denominador.
  - Falsos wakes: eventos que no solapan ninguna region. El timeline NUNCA se
    trocea: la continuidad de las rachas es la real (el canario de la
    auditoria — scores [.99,.1,.99] con la region en medio — da 0 falsos
    wakes porque los dos picos no son consecutivos en el timeline).
  - FAR: proporcion de ventanas negativas con score >= umbral y falsos wakes
    por minuto de audio negativo. Si no hay audio negativo, ambas metricas se
    reportan como NA (nunca un 0 inventado sin medicion).

Umbral: percentil --threshold-pct (por defecto 1) de los scores de los
positivos de entrenamiento de ese modelo. El bench NO elige el umbral de
produccion: reporta el paisaje para que la decision de adopcion contra el
baseline whisper-fonetico sea medida, no opinada.

Uso:
  wakeword-farfrr-bench.py --models DIR --cache train.npz --realpos DIR \
      --eval nico1:n1:nico1.pcm:231,275,394,469 \
      --eval nico2:n2:nico2.pcm:9,21,34,46,90,141

  --eval TAG:SEGPFX:PCM:REGIONES  TAG = identificador de la fuente evaluada;
  SEGPFX = prefijo de los segmentos de --realpos declarados derivados de esa
  fuente (se excluyen al entrenar su modelo, con source=TAG); PCM = clip
  int16 16 kHz; REGIONES = pushes centrales de las palabras, separados por
  comas.

Verificaciones por fold (fallan el bench si no se cumplen):
  - la fuente evaluada EXISTE en la cache de segmentos antes de excluirla
    (una exclusion vacia por nombre mal escrito no puede pasar desapercibida);
  - tras la exclusion, la interseccion de sources de entrenamiento con la
    fuente evaluada es vacia (assert, no confianza).
"""
import argparse
import importlib.util
import json
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
FIRST_SCORE_PUSH = 25  # primer push con score del runner (16 embeddings reales)
REGION_TOL = EMB_WINDOW + 10  # pushes de tolerancia alrededor del centro
PATIENCE = 2  # racha minima de scores >= umbral para formar un evento
PUSHES_PER_SECOND = 12.5  # 80 ms por push


def extract_events(scores: np.ndarray, ends: np.ndarray, thr: float, patience: int):
    """Eventos = rachas de >= patience ventanas consecutivas del timeline con
    score >= thr. Devuelve [(push_inicio, push_fin, score_max)]. La misma
    regla juzga positivos y negativos; rearme al caer bajo el umbral."""
    events = []
    run_start = None
    for i in range(len(scores)):
        if scores[i] >= thr:
            if run_start is None:
                run_start = i
        else:
            if run_start is not None and i - run_start >= patience:
                events.append((int(ends[run_start]), int(ends[i - 1]), float(scores[run_start:i].max())))
            run_start = None
    if run_start is not None and len(scores) - run_start >= patience:
        events.append((int(ends[run_start]), int(ends[-1]), float(scores[run_start:].max())))
    return events


def split_regions(centers, first_push: int):
    """Separa regiones evaluables de no evaluables por warmup (centro anterior
    al primer push punctuable). Devuelve (evaluables, no_evaluables)."""
    evaluables = [c for c in centers if c >= first_push]
    no_evaluables = [c for c in centers if c < first_push]
    return evaluables, no_evaluables


def assign_events(events, centers, tol: int):
    """Asigna cada evento a como mucho una region (la de centro mas cercano
    entre las que solapa). Devuelve (detectadas, no_detectadas, falsos_wakes,
    avisos). Un evento nunca puntua dos veces."""
    detected, ambiguous_notes = set(), []
    unassigned = []
    for ev_start, ev_end, ev_max in events:
        overlapped = [c for c in centers if ev_start <= c + tol and ev_end >= c - tol]
        if not overlapped:
            unassigned.append((ev_start, ev_end, ev_max))
            continue
        chosen = min(overlapped, key=lambda c: min(
            abs(ev_start - c), abs(ev_end - c), abs((ev_start + ev_end) / 2 - c)))
        if len(overlapped) > 1:
            ambiguous_notes.append(
                f"evento {ev_start}-{ev_end} solapa {len(overlapped)} regiones; "
                f"asignado solo a {chosen}"
            )
        detected.add(chosen)
    missed = [c for c in centers if c not in detected]
    return sorted(detected), missed, unassigned, ambiguous_notes


def far_metrics(scores: np.ndarray, ends: np.ndarray, centers, tol: int, thr: float):
    """Metricas sobre el audio negativo (fuera de TODA region declarada).
    (far_ventanas, n_negativas, segundos_negativos); None si no hay negativos."""
    in_any = np.zeros(len(ends), dtype=bool)
    for c in centers:
        in_any |= (ends >= c - tol) & (ends <= c + tol)
    neg = scores[~in_any]
    if len(neg) == 0:
        return None, 0, 0.0
    return float((neg >= thr).mean()), int(len(neg)), float(len(neg)) / PUSHES_PER_SECOND


def train_fold(caches: list[str], realpos: str, eval_source: str, seg_pfx: str, models: str, workdir: str, thr_pct: float):
    """Entrena (via wakeword-train.py, sin atajos) excluyendo la fuente evaluada."""
    import onnxruntime as ort

    segs = sorted(Path(realpos).glob("*.pcm"))
    clips = [f"real-{s.stem}:1:{s}:{eval_source}" for s in segs if s.stem.startswith(seg_pfx)]
    other = [f"real-{s.stem}:1:{s}:otros" for s in segs if not s.stem.startswith(seg_pfx)]
    if not clips:
        raise SystemExit(f"ningun segmento con prefijo {seg_pfx!r} en {realpos}")
    seg_cache = str(Path(workdir) / f"segments-{eval_source}.npz")
    subprocess.run(
        [sys.executable, str(HERE / "wakeword-windows.py"), "--models", models, "--out", seg_cache]
        + [arg for c in [*other, *clips] for arg in ("--clip", c)],
        check=True,
        capture_output=True,
    )
    # Verificacion 1: la fuente evaluada EXISTE en la cache antes de excluirla.
    zs = np.load(seg_cache)
    manifest = json.loads(str(zs["manifest_json"]))
    if eval_source not in manifest["sources"]:
        raise SystemExit(f"la fuente {eval_source!r} no existe en la cache de segmentos: exclusion vacia")
    out = str(Path(workdir) / f"model-{eval_source}.onnx")
    subprocess.run(
        [sys.executable, str(HERE / "wakeword-train.py"), "--exclude-source", eval_source, "--out", out]
        + [arg for c in [*caches, seg_cache] for arg in ("--cache", c)],
        check=True,
        capture_output=True,
    )
    # Verificacion 2: tras la exclusion, interseccion de sources vacia (assert).
    xs, ys = [], []
    for path in [*caches, seg_cache]:
        z = np.load(path)
        if "sources" not in z:
            raise SystemExit(f"{path} no tiene columna sources: regenerar con wakeword-windows.py v2")
        keep = z["sources"] != eval_source
        assert not (z["sources"][keep] == eval_source).any()
        xs.append(z["X"][keep])
        ys.append(z["y"][keep])
    X = np.vstack(xs)
    y = np.concatenate(ys)
    sess = ort.InferenceSession(out, providers=["CPUExecutionProvider"])
    inp = sess.get_inputs()[0].name
    scores = sess.run(None, {inp: X.reshape(-1, EMB_WINDOW, 96).astype(np.float32)})[0].squeeze(1)
    pos = np.sort(scores[y == 1])
    thr = float(pos[max(0, int(len(pos) * thr_pct / 100) - 1)])
    return sess, thr


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--models", required=True, help="dir con melspectrogram.onnx y embedding_model.onnx")
    ap.add_argument("--cache", action="append", required=True, help="cache de entrenamiento (.npz con sources)")
    ap.add_argument("--realpos", required=True, help="dir con segmentos reales aumentados (*.pcm)")
    ap.add_argument("--eval", action="append", required=True, metavar="TAG:SEGPFX:PCM:R1,R2,...", help="clip de evaluacion leave-one-source-out")
    ap.add_argument("--threshold-pct", type=float, default=1.0, help="percentil de positivos para el umbral (defecto 1)")
    ap.add_argument("--patience", type=int, default=PATIENCE, help="racha minima para evento (defecto 2)")
    args = ap.parse_args()

    with tempfile.TemporaryDirectory() as workdir:
        for spec_arg in args.eval:
            tag, pfx, pcm, regions = spec_arg.split(":", 3)
            centers = [int(r) for r in regions.split(",")]
            sess, thr = train_fold(args.cache, args.realpos, tag, pfx, args.models, workdir, args.threshold_pct)
            embs = ww.embeddings_of(pcm, args.models)
            W, ends = ww.windows_of(embs)
            inp = sess.get_inputs()[0].name
            s = sess.run(None, {inp: W.reshape(-1, EMB_WINDOW, 96).astype(np.float32)})[0].squeeze(1)

            evaluables, no_evaluables = split_regions(centers, FIRST_SCORE_PUSH)
            events = extract_events(s, ends, thr, args.patience)
            detected, missed, false_wakes, notes = assign_events(events, evaluables, REGION_TOL)
            far_w, n_neg, neg_secs = far_metrics(s, ends, centers, REGION_TOL, thr)

            print(f"[LOCO {tag}] thr(p{args.threshold_pct:g})={thr:.3f} paciencia={args.patience}")
            if no_evaluables:
                print(f"  no evaluables por warmup (centro < push {FIRST_SCORE_PUSH}): {no_evaluables}")
            print(
                f"  deteccion: {len(detected)}/{len(evaluables)} regiones evaluables "
                f"(detectadas {detected}{'; MISS ' + str(missed) if missed else ''})"
            )
            for note in notes:
                print(f"  aviso: {note}")
            if far_w is None:
                print("  FAR: NA (0 ventanas negativas fuera de region: no hay medicion, no es 0)")
                print(f"  falsos wakes: {len(false_wakes)} (sin audio negativo de referencia)")
            else:
                rate = len(false_wakes) / (neg_secs / 60)
                print(
                    f"  FAR ventanas: {far_w:.4f} sobre {n_neg} ({neg_secs:.1f}s negativos) | "
                    f"falsos wakes: {len(false_wakes)} = {rate:.2f}/min | "
                    f"eventos: {[(a, b) for a, b, _ in false_wakes][:10]}"
                )


if __name__ == "__main__":
    main()
