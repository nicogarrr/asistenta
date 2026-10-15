#!/usr/bin/env python3
"""A1a ronda 2 (auditor #138) — arnés de paridad, lado Python OFICIAL.

Mismo PCM int16 por el openwakeword v0.5.1 OFICIAL (pip install
openwakeword==0.5.1 --no-deps + onnxruntime, modelos del release v0.5.1).
Vuelca score por push y la fila NUEVA del feature_buffer tras cada push
(el embedding real de ese push; el buffer arranca sembrado con ~41
embeddings de ruido, que el clasificador expulsa en el push 25 — a partir
de ahí la comparación es exacta).

Uso: python3 scripts/wakeword-parity.py <audio.int16.pcm> <modelsDir> <out.json>
"""
import json
import sys

import numpy as np

np.random.seed(0)  # la semilla solo toca embeddings pre-warmup (push < 25)

from openwakeword.model import Model  # noqa: E402

pcm_path, models_dir, out_path = sys.argv[1], sys.argv[2], sys.argv[3]

x = np.fromfile(pcm_path, dtype=np.int16)
n_pushes = len(x) // 1280
x = x[: n_pushes * 1280]

mdl = Model(
    wakeword_models=[f"{models_dir}/hey_jarvis_v0.1.onnx"],
    inference_framework="onnx",
    melspec_model_path=f"{models_dir}/melspectrogram.onnx",
    embedding_model_path=f"{models_dir}/embedding_model.onnx",
)
seed_len = int(mdl.preprocessor.feature_buffer.shape[0])

scores = []
embeddings = []
for p in range(n_pushes):
    pred = mdl.predict(x[p * 1280 : (p + 1) * 1280])
    scores.append(float(list(pred.values())[0]))
    embeddings.append([float(v) for v in mdl.preprocessor.feature_buffer[-1]])

with open(out_path, "w") as fh:
    json.dump(
        {"seedLen": seed_len, "nPushes": n_pushes, "scores": scores, "embeddings": embeddings},
        fh,
    )
print(f"python-oficial: {n_pushes} pushes, seed {seed_len}, -> {out_path}")
