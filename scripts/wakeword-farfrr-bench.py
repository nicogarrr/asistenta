#!/usr/bin/env python3
"""Item A1b — bench FAR/FRR del clasificador "chochi" con protocolo
leave-one-source-out: ningun dato cuya PROCEDENCIA RAIZ sea el clip evaluado
entra en su modelo.

PROCEDENCIA (objecion 3, rondas 1-2 #139): la procedencia NO se fabrica por
prefijo en cada fold. Los segmentos de --realpos traen un manifest.json:
  {"roots":   {"nico1": {"sha256": "<sha del clip original>"}, ...},
   "segments": {"n1-a-0.9-0.7.pcm": "nico1", ...}}
El bench exige que (a) todo *.pcm del directorio este en "segments", (b) la
fuente evaluada exista en "roots", y (c) el sha256 del clip evaluado coincida
con el declarado para su raiz — asi el segmento aumentado queda vinculado al
original por hash, no por nombre. La exclusion es por root_source_id y el
assert de interseccion vacia ya no es una tautologia: las fuentes las escribio
el manifest, no el fold.

REGLA UNICA DE EVENTOS (objeciones 1-2, rondas 1-2): positivos y negativos se
juzgan con el criterio operativo del listener: un EVENTO es una racha de >=
PACIENCIA ventanas CONSECUTIVAS del timeline completo con score >= umbral, y
su INSTANTE DE DISPARO (trigger) es el push en que la racha alcanza la
paciencia: start + paciencia - 1. El listener despierta en el trigger, no al
final de la racha: una racha larga que empezo ANTES de la palabra no puede
lavar un falso temprano (canario del auditor: scores=1 de 25 a 124 con la
palabra en 100 -> trigger 26 -> falso wake + palabra perdida, no un hit).

  - Deteccion: region EVALUABLE (centro entre el primer push punctuable, 25,
    y el ultimo push del audio) cuyo intervalo centro +- REGION_TOL contiene
    el TRIGGER de un evento. Cada evento alimenta como mucho una region (la
    de centro mas cercano; ambiguedad reportada) y cada racha tiene un unico
    trigger: un evento activo no rearma, una racha no puede detectar dos
    palabras.
  - Ignorados: eventos cuyo trigger cae bajo una region NO evaluable
    (warmup o mas alla del fin del audio). Ni hits ni falsos: se reportan
    aparte, porque ni la deteccion ni la exposicion negativa los cubren.
  - Falsos wakes: eventos cuyo trigger cae en territorio EXPUESTO (fuera de
    toda region declarada). El denominador de FAR es exactamente ese mismo
    territorio: numerador y exposicion coherentes (objecion 2, ronda 2).
  - FAR: proporcion de ventanas expuestas con score >= umbral y falsos wakes
    por minuto de audio expuesto. Si no hay exposicion, ambas son NA (nunca
    un 0 inventado sin medicion).

Umbral: percentil --threshold-pct (defecto 1) de los scores de los positivos
de entrenamiento de ese modelo. El bench NO elige el umbral de produccion.

Uso:
  wakeword-farfrr-bench.py --models DIR --cache train.npz --realpos DIR \
      --eval nico1:nico1.pcm:231,275,394,469 \
      --eval nico2:nico2.pcm:9,21,34,46,90,141

  --eval TAG:PCM:REGIONES  TAG = raiz declarada en el manifest de --realpos;
  PCM = clip int16 16 kHz (su sha256 debe coincidir con el de la raiz);
  REGIONES = pushes centrales de las palabras, separados por comas.
"""
import argparse
import hashlib
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
    score >= thr. Devuelve [(start_push, end_push, score_max, trigger_push)];
    trigger = push en que la racha alcanza la paciencia (el instante en que
    despertaria el listener). Una racha activa no rearma: un solo trigger."""
    events = []
    run_start = None
    for i in range(len(scores)):
        if scores[i] >= thr:
            if run_start is None:
                run_start = i
        else:
            if run_start is not None and i - run_start >= patience:
                events.append((
                    int(ends[run_start]),
                    int(ends[i - 1]),
                    float(scores[run_start:i].max()),
                    int(ends[run_start + patience - 1]),
                ))
            run_start = None
    if run_start is not None and len(scores) - run_start >= patience:
        events.append((
            int(ends[run_start]),
            int(ends[-1]),
            float(scores[run_start:].max()),
            int(ends[run_start + patience - 1]),
        ))
    return events


def split_regions(centers, first_push: int, last_push: int):
    """Evaluables = centro dentro del audio punctuable [first_push, last_push].
    No evaluables: warmup (antes del primer score) o mas alla del fin."""
    evaluables = [c for c in centers if first_push <= c <= last_push]
    no_evaluables = [c for c in centers if c < first_push or c > last_push]
    return evaluables, no_evaluables


def assign_events(events, evaluables, no_evaluables, tol: int):
    """Clasifica cada evento por su TRIGGER: hit (region evaluable), ignorado
    (region no evaluable: ni hit ni falso) o falso wake (territorio expuesto).
    Devuelve (detectadas, no_detectadas, falsos, ignorados, avisos)."""
    detected, falsos, ignorados, notas = set(), [], [], []
    for st, en, mx, trig in events:
        hits = [c for c in evaluables if abs(trig - c) <= tol]
        if hits:
            chosen = min(hits, key=lambda c: abs(trig - c))
            if len(hits) > 1:
                notas.append(f"evento trigger {trig} solapa {len(hits)} regiones; asignado solo a {chosen}")
            detected.add(chosen)
            continue
        if any(abs(trig - c) <= tol for c in no_evaluables):
            ignorados.append((st, en, mx, trig))
            continue
        falsos.append((st, en, mx, trig))
    missed = [c for c in evaluables if c not in detected]
    return sorted(detected), missed, falsos, ignorados, notas


def far_metrics(scores: np.ndarray, ends: np.ndarray, centers, tol: int, thr: float):
    """Exposicion negativa = ventanas fuera de TODA region declarada (la misma
    tierra donde un trigger cuenta como falso wake).
    (far_ventanas, n_expuestas, segundos_expuestos); None si no hay exposicion."""
    in_any = np.zeros(len(ends), dtype=bool)
    for c in centers:
        in_any |= (ends >= c - tol) & (ends <= c + tol)
    neg = scores[~in_any]
    if len(neg) == 0:
        return None, 0, 0.0
    return float((neg >= thr).mean()), int(len(neg)), float(len(neg)) / PUSHES_PER_SECOND


def train_fold(caches: list[str], realpos: str, eval_source: str, eval_pcm: str, models: str, workdir: str, thr_pct: float):
    """Entrena (via wakeword-train.py, sin atajos) excluyendo la raiz evaluada.
    La procedencia de cada segmento se lee del manifest.json del directorio;
    el sha256 del clip evaluado debe coincidir con el de su raiz declarada."""
    import onnxruntime as ort

    man_path = Path(realpos) / "manifest.json"
    if not man_path.exists():
        raise SystemExit(f"{man_path} no existe: la procedencia de los segmentos no es verificable")
    man = json.loads(man_path.read_text())
    roots = man.get("roots", {})
    segments = man.get("segments", {})
    if eval_source not in roots:
        raise SystemExit(f"la fuente {eval_source!r} no esta en roots del manifest: exclusion vacia")
    eval_sha = hashlib.sha256(open(eval_pcm, "rb").read()).hexdigest()
    if roots[eval_source].get("sha256") != eval_sha:
        raise SystemExit(
            f"el sha256 de {eval_pcm} no coincide con el de la raiz {eval_source!r} del manifest: "
            "no se puede garantizar que los segmentos derivan de este clip"
        )
    segs = sorted(Path(realpos).glob("*.pcm"))
    unknown = [s.name for s in segs if s.name not in segments]
    if unknown:
        raise SystemExit(f"segmentos sin procedencia declarada en el manifest: {unknown[:5]}")
    clips = [f"real-{s.stem}:1:{s}:{segments[s.name]}" for s in segs]
    seg_cache = str(Path(workdir) / f"segments-{eval_source}.npz")
    subprocess.run(
        [sys.executable, str(HERE / "wakeword-windows.py"), "--models", models, "--out", seg_cache]
        + [arg for c in clips for arg in ("--clip", c)],
        check=True,
        capture_output=True,
    )
    out = str(Path(workdir) / f"model-{eval_source}.onnx")
    subprocess.run(
        [sys.executable, str(HERE / "wakeword-train.py"), "--exclude-source", eval_source, "--out", out]
        + [arg for c in [*caches, seg_cache] for arg in ("--cache", c)],
        check=True,
        capture_output=True,
    )
    xs, ys = [], []
    excluded = 0
    for path in [*caches, seg_cache]:
        z = np.load(path)
        if "sources" not in z:
            raise SystemExit(f"{path} no tiene columna sources: regenerar con wakeword-windows.py v2")
        keep = z["sources"] != eval_source
        excluded += int((~keep).sum())
        xs.append(z["X"][keep])
        ys.append(z["y"][keep])
    X = np.vstack(xs)
    y = np.concatenate(ys)
    assert excluded > 0, f"la exclusion de {eval_source!r} no retiro ninguna ventana: exclusion vacia"
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
    ap.add_argument("--realpos", required=True, help="dir con segmentos reales aumentados y manifest.json")
    ap.add_argument("--eval", action="append", required=True, metavar="TAG:PCM:R1,R2,...", help="clip de evaluacion leave-one-source-out")
    ap.add_argument("--threshold-pct", type=float, default=1.0, help="percentil de positivos para el umbral (defecto 1)")
    ap.add_argument("--patience", type=int, default=PATIENCE, help="racha minima para evento (defecto 2)")
    args = ap.parse_args()

    with tempfile.TemporaryDirectory() as workdir:
        for spec_arg in args.eval:
            tag, pcm, regions = spec_arg.split(":", 2)
            centers = [int(r) for r in regions.split(",")]
            sess, thr = train_fold(args.cache, args.realpos, tag, pcm, args.models, workdir, args.threshold_pct)
            embs = ww.embeddings_of(pcm, args.models)
            W, ends = ww.windows_of(embs)
            inp = sess.get_inputs()[0].name
            s = sess.run(None, {inp: W.reshape(-1, EMB_WINDOW, 96).astype(np.float32)})[0].squeeze(1)

            last_push = int(ends[-1])
            evaluables, no_evaluables = split_regions(centers, FIRST_SCORE_PUSH, last_push)
            events = extract_events(s, ends, thr, args.patience)
            detected, missed, falsos, ignorados, notas = assign_events(events, evaluables, no_evaluables, REGION_TOL)
            far_w, n_neg, neg_secs = far_metrics(s, ends, centers, REGION_TOL, thr)

            print(f"[LOCO {tag}] thr(p{args.threshold_pct:g})={thr:.3f} paciencia={args.patience}")
            if no_evaluables:
                print(f"  no evaluables (warmup < push {FIRST_SCORE_PUSH} o > fin {last_push}): {no_evaluables}")
            print(
                f"  deteccion: {len(detected)}/{len(evaluables)} regiones evaluables "
                f"(detectadas {detected}{'; MISS ' + str(missed) if missed else ''})"
            )
            for nota in notas:
                print(f"  aviso: {nota}")
            if ignorados:
                print(f"  ignorados bajo region no evaluable (ni hits ni falsos): {[(t,) for *_, t in ignorados]}")
            if far_w is None:
                print("  FAR: NA (0 ventanas expuestas: no hay medicion, no es 0)")
                print(f"  falsos wakes: {len(falsos)} (sin audio expuesto de referencia)")
            else:
                rate = len(falsos) / (neg_secs / 60)
                print(
                    f"  FAR ventanas: {far_w:.4f} sobre {n_neg} ({neg_secs:.1f}s expuestos) | "
                    f"falsos wakes: {len(falsos)} = {rate:.2f}/min | "
                    f"triggers: {[t for *_, t in falsos][:10]}"
                )


if __name__ == "__main__":
    main()
