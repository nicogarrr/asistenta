#!/usr/bin/env python3
"""Item A1b — entrena el clasificador de la palabra "chochi" sobre una cache de
ventanas (wakeword-windows.py) y lo exporta a ONNX con el contrato exacto que
consume OwwWakeDetector: entrada float32 [1,16,96], salida [1,1] con el score
en [0,1] (el runner lee los nombres de entrada/salida dinamicamente; las
dimensiones vienen fijadas por OWW_EMB_WINDOW=16 y OWW_EMB_SIZE=96 en
src/voice/wakeword-oww.ts).

Arquitectura: MLP 1536 -> 64 -> 1 (relu + sigmoide), la misma capacidad que
el MLPClassifier(64) del spike con el que se midio deteccion 10/10 cross-clip;
se reimplementa en torch porque el runner carga ONNX y sklearn no exporta a
este contrato.

Estandarizacion: las ventanas se estandarizan con la media y desviacion del
set de entrenamiento, y esa normalizacion va DENTRO del grafo ONNX exportado
(el runner entrega embeddings crudos; el modelo se normaliza a si mismo), asi
el contrato de entrada sigue siendo float32 [1,16,96] sin cambios en el runner.

Determinismo: semilla fija (torch, numpy y el generador del barajado), CPU, sin
dropout ni aumento aleatorio en el bucle (el aumento vive en los datos). Misma
semilla y mismos datos -> mismo modelo.

Umbral operativo: percentil 1 de los scores de los positivos de entrenamiento
(la regla con la que el spike midio sus numeros). El bench FAR/FRR
(wakeword-farfrr-bench.py) es quien decide umbral y paciencia de produccion;
aqui se reporta como referencia.

Verificacion incluida (no hay que creerse la exportacion): el script vuelve a
cargar el .onnx con onnxruntime y compara scores torch vs onnx sobre todas las
ventanas de entrenamiento; imprime el max |diff| y aborta si supera 1e-5.

Uso:
  wakeword-train.py --cache train.npz [--cache mas.npz ...] \
      [--exclude-tag-prefix nico] --out chochi.onnx

--exclude-source descarta las ventanas cuya PROCEDENCIA declarada (columna
sources de la cache, escrita por wakeword-windows.py v2) coincide con la
fuente evaluada; la exclusion por procedencia cubre todos los aumentos de esa
fuente. Tras los filtros se validan AMBOS grupos (objecion 4, ronda 1 #139):
sin positivos o sin negativos, el entrenamiento aborta en vez de producir un
modelo cojo.
"""
import argparse

import numpy as np

EMB_WINDOW = 16
EMB_SIZE = 96
INPUT_DIM = EMB_WINDOW * EMB_SIZE
HIDDEN = 64
EPOCHS = 60
BATCH = 256
LR = 3e-4
PARITY_TOL = 1e-5


def load_caches(paths: list[str], exclude_source: str | None) -> tuple[np.ndarray, np.ndarray]:
    xs, ys = [], []
    for path in paths:
        z = np.load(path)
        if exclude_source is not None:
            if "sources" not in z:
                raise SystemExit(f"{path} no tiene columna sources: regenerar con wakeword-windows.py v2")
            keep = z["sources"] != exclude_source
        else:
            keep = np.ones(len(z["X"]), dtype=bool)
        xs.append(z["X"][keep])
        ys.append(z["y"][keep])
        print(f"[train] {path}: {int(keep.sum())} ventanas ({int(z['y'][keep].sum())} positivas)")
    return np.vstack(xs), np.concatenate(ys)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cache", action="append", required=True, help="cache .npz de wakeword-windows.py")
    ap.add_argument("--exclude-source", default=None, help="descarta ventanas de esta fuente (procedencia)")
    ap.add_argument("--out", required=True, help="ruta del .onnx de salida")
    args = ap.parse_args()

    import onnxruntime as ort
    import torch

    torch.manual_seed(0)
    np.random.seed(0)
    torch.use_deterministic_algorithms(True, warn_only=True)

    X, y = load_caches(args.cache, args.exclude_source)
    if int(y.sum()) == 0:
        raise SystemExit("sin positivos tras los filtros: no hay nada que entrenar")
    if int((y == 0).sum()) == 0:
        raise SystemExit("sin negativos tras los filtros: un clasificador sin negativos no discrimina")
    xt = torch.from_numpy(X.astype(np.float32))
    yt = torch.from_numpy(y.astype(np.float32)).unsqueeze(1)

    mean = xt.mean(dim=0)
    std = xt.std(dim=0).clamp_min(1e-6)

    model = torch.nn.Sequential(
        torch.nn.Linear(INPUT_DIM, HIDDEN),
        torch.nn.ReLU(),
        torch.nn.Linear(HIDDEN, 1),
        torch.nn.Sigmoid(),
    )
    opt = torch.optim.Adam(model.parameters(), lr=LR)
    loss_fn = torch.nn.BCELoss()
    gen = torch.Generator().manual_seed(0)
    model.train()
    for epoch in range(EPOCHS):
        perm = torch.randperm(len(xt), generator=gen)
        epoch_loss, nbatches = 0.0, 0
        for i in range(0, len(xt), BATCH):
            idx = perm[i : i + BATCH]
            xb = (xt[idx] - mean) / std
            opt.zero_grad()
            loss = loss_fn(model(xb), yt[idx])
            loss.backward()
            opt.step()
            epoch_loss += float(loss)
            nbatches += 1
    model.eval()
    print(f"[train] {EPOCHS} epocas x {nbatches} lotes de {BATCH}, loss final {epoch_loss / nbatches:.5f}")

    with torch.no_grad():
        pos_scores = model(((xt - mean) / std)[yt.squeeze(1) == 1]).squeeze(1).numpy()
    thr = float(np.sort(pos_scores)[max(0, int(len(pos_scores) * 0.01) - 1)])
    print(f"[train] umbral referencia (p1 de positivos): {thr:.4f} sobre {len(pos_scores)} positivos")

    class Export(torch.nn.Module):
        """Vista [B,16,96] -> [B,1]: el aplanado 16x96 -> 1536 va DENTRO del
        grafo para que el .onnx acepte el tensor tridimensional del runner."""

        def __init__(self, net: torch.nn.Module, mean: torch.Tensor, std: torch.Tensor) -> None:
            super().__init__()
            self.net = net
            # constantes horneadas en el grafo: el .onnx normaliza solo
            self.register_buffer("mean", mean)
            self.register_buffer("std", std)

        def forward(self, x: torch.Tensor) -> torch.Tensor:
            flat = x.reshape(x.shape[0], INPUT_DIM)
            return self.net((flat - self.mean) / self.std)

    dummy = torch.zeros(1, EMB_WINDOW, EMB_SIZE, dtype=torch.float32)
    torch.onnx.export(
        Export(model, mean, std),
        dummy,
        args.out,
        input_names=["input"],
        output_names=["score"],
        opset_version=17,
        # lote dinamico: el runner siempre pasa [1,16,96], pero el bench y la
        # verificacion de paridad puntuan lotes enteros de una vez
        dynamic_axes={"input": {0: "batch"}, "score": {0: "batch"}},
    )
    print(f"[train] ONNX escrito en {args.out}")

    # Paridad torch vs onnx sobre TODO el entrenamiento (no una muestra).
    sess = ort.InferenceSession(args.out, providers=["CPUExecutionProvider"])
    inp = sess.get_inputs()[0].name
    onnx_scores = sess.run(None, {inp: xt.reshape(-1, EMB_WINDOW, EMB_SIZE).numpy()})[0].squeeze(1)
    with torch.no_grad():
        torch_scores = model((xt - mean) / std).squeeze(1).numpy()
    diff = float(np.max(np.abs(onnx_scores - torch_scores)))
    print(f"[train] paridad torch<->onnx: max |diff| = {diff:.3e} ({len(onnx_scores)} ventanas)")
    if diff > PARITY_TOL:
        raise SystemExit(f"paridad torch<->onnx {diff:.3e} supera la tolerancia {PARITY_TOL:g}")


if __name__ == "__main__":
    main()
