"""A5: bench Silero VAD vs gate RMS (protocolo del spike, reproducible).

Uso: python3 scripts/vad-silero-bench.py <modelo.onnx> <src1.pcm> [src2.pcm ...]
PCMs int16 mono 16 kHz. Cada fuente se etiqueta --speech o --nonspeech con el
nombre: los ficheros cuyo nombre empieza por "speech-" se miden por RECALL de
voz (fraccion de tramos de 3s que el VAD deja pasar; debe ser ~1) y el resto
por RECHAZO de no-voz a ganancias RMS 0.032/0.05/0.1/0.2 comparado con el gate
RMS 0.05 de src/voice/wake.ts.

Datos del spike A5 (oct 2026), dominio publico de Wikimedia Commons:
  - white-noise: File:White noise.ogg, sha256(ogg) dde19c997f1f74536f186a8a9f725947363a6af0c36f81089879ee7191460540
  - musica: File:William Tell Overture - Edison.ogg, sha256(ogg) 2e415a0e32c2a51961b9b7c97f84e9a50fcfee62bcf9630f86401b151cf42574
  - habla: 105 segmentos reales "chochi" (realpos A1b, manifest con sha256 de raices)
Modelo: snakers4/silero-vad v4.0 oficial, sha256 a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28

Resultados del spike (VM de desarrollo): ruido blanco rechazado 19/19 a toda
ganancia (RMS pasa 19/19 desde 0.1); orquesta pasa ~45-47/86 vs 85/86 RMS
(limite declarado: pasajes sostenidos parecen voz); habla 105/105 segmentos,
12/13 tramos en nico1 (igual que RMS); coste ~156s CPU/hora en python naive.
"""
import os, sys, time
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

def main():
    model, *srcs = sys.argv[1:]
    sess = ort.InferenceSession(model, providers=["CPUExecutionProvider"])
    for path in srcs:
        pcm = np.fromfile(path, dtype=np.int16).astype(np.float32) / 32768.0
        name = os.path.basename(path)
        t0 = time.perf_counter(); base_probs = vad_probs(sess, pcm); el = time.perf_counter() - t0
        dur = len(pcm) / SR
        print(f"== {name} ({dur:.1f}s, RMS base {rms(pcm):.4f}, coste {el/dur*3600:.0f}s CPU/hora)")
        if name.startswith("speech-"):
            n3 = len(pcm) // (3*SR)
            vp = sum(1 for i in range(n3) if base_probs[i*3*SR//WIN:(i+1)*3*SR//WIN].max(initial=0) >= 0.5)
            print(f"   HABLA: VAD@0.5 pasa {vp}/{n3} tramos 3s (recall; debe ser ~1)")
            continue
        base = rms(pcm)
        for target in (0.032, 0.05, 0.1, 0.2):
            x = np.clip(pcm * (target/base if base else 0), -1, 1)
            p = base_probs if target == round(base, 3) else vad_probs(sess, x)
            n3 = len(x) // (3*SR)
            rp = sum(1 for i in range(n3) if rms(x[i*3*SR:(i+1)*3*SR]) >= 0.05)
            vp = sum(1 for i in range(n3) if p[i*3*SR//WIN:(i+1)*3*SR//WIN].max(initial=0) >= 0.5)
            print(f"   RMS {target:.3f}: RMS-gate {rp}/{n3} | VAD@0.5 {vp}/{n3} | prob mediana {np.median(p):.4f}")

if __name__ == "__main__":
    main()
