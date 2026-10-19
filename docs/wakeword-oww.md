# Motor de palabra de activacion openWakeWord (oww)

Estado: **detras de flag, no es el motor por defecto**. El motor whisper
(transcribir cada ventana y comparar texto) sigue siendo el activo salvo que
se pida oww. Falta la medida FAR/FRR de A1b contra el matcher whisper en el
PC de Nico: oww solo se hara default si mejora lo que existe.

## Que cambia con oww

El motor whisper cuesta ~1-2 s de CPU por ventana de 3 s que supera la puerta
de energia, y necesita un matcher fonetico porque whisper deletrea "chochi"
como "Choci"/"Chuchis"/"Chocchi". El runner oww
(`src/voice/wakeword-oww.ts`, pipeline oficial v0.5.1 replicado y con paridad
medida en `scripts/wakeword-parity.*`) no transcribe: tres modelos ONNX
pequenos puntuan cada frame de 80 ms y el primer score llega a los ~2,0 s de
audio. El coste por segundo de audio es pequeno y constante.

Limitacion deliberada: oww **no transcribe**, solo sabe QUE sono la palabra.
Al disparar, `cli.ts` abre una sesion de conversacion (aunque el modo
conversacion este apagado) y la peticion se dice despues de la palabra; no
vale "chochi, pon musica" en una sola frase como con whisper.

## Activacion

```
PA_WAKE_ENGINE=oww
PA_WAKE_OWW_MODEL=chochi.onnx        # nombre simple .onnx, obligatorio
PA_WAKE_OWW_THRESHOLD=0.5            # opcional, 0..1
```

Los modelos viven en `paths.models/oww/` (el dir de estado, nunca en el
repo). `melspectrogram.onnx` y `embedding_model.onnx` se descargan solos del
release oficial v0.5.1 (Apache-2.0) la primera vez; el modelo de palabra hay
que entrenarlo (abajo). Si falta, el arranque falla con este mismo mensaje
de ruta, nunca con un silencio.

## Ruta de entrenamiento del modelo de palabra

1. **Grabar muestras**: clips propios de la palabra ("chochi") en el micro
   real, mas negativos (habla normal, ruido de casa). 16 kHz mono.
2. **Cachear ventanas** de embeddings con `scripts/wakeword-windows.py`
   (replica el AudioFeatures oficial; ver su docstring para las opciones).
3. **Entrenar y exportar**:
   `python scripts/wakeword-train.py --cache <positivos.npz> --cache <negativos.npz> --out <estado>/models/oww/chochi.onnx`
   MLP 1536->64->1 con la normalizacion dentro del grafo ONNX, semilla fija,
   y verificacion de la exportacion (torch vs onnxruntime, max |diff| < 1e-5
   o aborta).
4. **Medir antes de adoptar**: `scripts/wakeword-farfrr-bench.py` da FAR/FRR
   y el umbral recomendado; `PA_WAKE_OWW_THRESHOLD` se ajusta a eso. Regla:
   oww solo sustituye a whisper si lo mejora medido.

## Verificado y no verificado

- Verificado en CI: troceado en frames, disparo por umbral, suppression/hold
  con reset (sin falsos wakes del audio encolado), cierre de sesiones ONNX y
  config (tests `wake-oww-engine`, `wakeword-oww`).
- Verificado fuera de CI (scripts opt-in): paridad numerica con el Python
  oficial y el spike de deteccion 10/10 cross-clip del clasificador entrenado.
- **No verificado**: oww escuchando en el PC de Nico con el micro real ni la
  comparativa FAR/FRR definitiva contra whisper (A1b pendiente; por eso el
  motor sigue detras de flag).
