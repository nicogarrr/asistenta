"""A5: bench Silero VAD vs gate RMS (protocolo del spike, reproducible).

Uso:
  # No-voz (barrido de ganancias RMS 0.032/0.05/0.1/0.2, tramos de 3s como wake.ts):
  OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 python3 scripts/vad-silero-bench.py \\
      /tmp/oww-spike/models/silero_vad.onnx white-noise-60s.pcm william-tell.pcm

  # Habla por clip (unidad del spike: prob MAXIMA del clip >= 0.5):
  OMP_NUM_THREADS=1 python3 scripts/vad-silero-bench.py --clip \\
      /tmp/oww-spike/models/silero_vad.onnx /tmp/a1b-spike/realpos/n1-*.pcm

  # Habla larga (tramos de 3s, recall por tramo):
  OMP_NUM_THREADS=1 python3 scripts/vad-silero-bench.py \\
      /tmp/oww-spike/models/silero_vad.onnx speech-nico1.pcm

PCMs int16 mono 16 kHz. Sin --clip: los ficheros cuyo nombre empieza por
"speech-" se evaluan por RECALL por tramo de 3s (fraccion que el VAD deja
pasar; debe ser ~1) y el resto por RECHAZO de no-voz al barrido de ganancias.
El coste se mide con process_time (CPU real, no pared) y los comandos fijan un
solo hilo; cifra medida: 76s CPU/hora = ~2,1% de un core (Python naive, VM de
desarrollo). Una cifra anterior del spike (156s/h, perf_counter = tiempo de
pared) media espera, no CPU — corregida tras objecion del auditor A5 r1.

Datos del spike A5 (oct 2026), dominio publico de Wikimedia Commons:
  - white-noise: File:White noise.ogg, sha256(ogg) dde19c997f1f74536f186a8a9f725947363a6af0c36f81089879ee7191460540
  - musica: File:William Tell Overture - Edison.ogg, sha256(ogg) 2e415a0e32c2a51961b9b7c97f84e9a50fcfee62bcf9630f86401b151cf42574
  - habla: 105 segmentos reales "chochi" (realpos A1b, manifest con sha256 de raices)
Modelo: snakers4/silero-vad v4.0 oficial, sha256 a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28

Resultados del spike (VM de desarrollo): ruido blanco rechazado 19/19 a toda
ganancia (RMS pasa 19/19 desde 0.1); orquesta pasa ~45-47/86 vs 85/86 RMS
(limite declarado: pasajes sostenidos parecen voz); habla 105/105 clips con
prob max >= 0.996, 12/13 tramos en nico1 (igual que RMS).
"""
import glob, os, sys, time
import numpy as np
import onnxruntime as ort

SR, WIN = 16000, 512

def vad_probs(sess, pcm):
    n = len(pcm) // WIN
    h = np.zeros((2, 1, 64), np.float32); c = np.zeros((2, 1, 64), np.float32)
    sr = np.array(SR, dtype=np.int64)
    out = np.empty(n, np.float32)
    for i in range(n):
        o, h, c = sess.run(["output", "hn", "cn"], {"input": pcm[i*WIN:(i+1)*WIN].reshape(1, WIN), "sr": sr, "h": h, "c": c})
        out[i] = o[0, 0]
    return out

def rms(x): return float(np.sqrt(np.mean(x**2))) if len(x) else 0.0

def load(p): return np.fromfile(p, dtype=np.int16).astype(np.float32) / 32768.0

def main():
    args = sys.argv[1:]
    clip_mode = "--clip" in args
    args = [a for a in args if a != "--clip"]
    model, *patterns = args
    sess = ort.InferenceSession(model, providers=["CPUExecutionProvider"])
    srcs = []
    for p in patterns:
        srcs.extend(sorted(glob.glob(p)) or [p])

    if clip_mode:
        ok = 0
        maxps = []
        for path in srcs:
            pcm = load(path)
            m = float(vad_probs(sess, pcm).max(initial=0.0))
            maxps.append(m)
            ok += m >= 0.5
        maxps = np.array(maxps)
        print(f"CLIP: {len(srcs)} clips, recall@0.5 = {ok}/{len(srcs)} = {ok/max(len(srcs),1):.3f}")
        print(f"      prob max por clip: min {maxps.min():.3f} p25 {np.percentile(maxps,25):.3f} mediana {np.median(maxps):.3f}")
        return

    for path in srcs:
        pcm = load(path)
        name = os.path.basename(path)
        dur = len(pcm) / SR
        t0 = time.process_time()
        base_probs = vad_probs(sess, pcm)
        cpu = time.process_time() - t0
        print(f"== {name} ({dur:.1f}s, RMS base {rms(pcm):.4f}, coste {cpu/dur*3600:.0f}s CPU/hora [process_time])")
        if name.startswith("speech-"):
            n3 = len(pcm) // (3*SR)
            vp = sum(1 for i in range(n3) if base_probs[i*3*SR//WIN:(i+1)*3*SR//WIN].max(initial=0) >= 0.5)
            print(f"   HABLA: VAD@0.5 pasa {vp}/{n3} tramos 3s (recall; debe ser ~1)")
            continue
        base = rms(pcm)
        for target in (0.032, 0.05, 0.1, 0.2):
            # El audio SIEMPRE se reescala y se reevalua: reutilizar probs del
            # original cuando target ~ base fue un bug del spike (auditor A5 r1).
            x = np.clip(pcm * (target/base if base else 0), -1, 1)
            p = vad_probs(sess, x)
            n3 = len(x) // (3*SR)
            rp = sum(1 for i in range(n3) if rms(x[i*3*SR:(i+1)*3*SR]) >= 0.05)
            vp = sum(1 for i in range(n3) if p[i*3*SR//WIN:(i+1)*3*SR//WIN].max(initial=0) >= 0.5)
            print(f"   RMS {target:.3f}: RMS-gate {rp}/{n3} | VAD@0.5 {vp}/{n3} | prob mediana {np.median(p):.4f}")

if __name__ == "__main__":
    main()
