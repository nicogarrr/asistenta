# Voz local (sherpa-onnx) y Piper

## Voz local neuronal, sin instalar nada (por defecto en Windows)

Las respuestas habladas usan una voz neuronal local con [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx): gratis, sin red una vez descargada y dentro del propio proceso. Empieza a sonar en ~0,1 s (Piper, ~0,3 s), no satura el audio y, en una prueba con 15 frases (fechas, euros, nombres, palabras en inglés), se le entendió mejor que a Piper: 6,2 % de palabras mal frente a 9,0 %, con la voz castellana «sharvard».

- **Primer arranque** (y tras una actualización que cambie el modelo): la consola muestra `Voz local «kokoro»: descargando 350 MB en segundo plano…`, luego el porcentaje cada 10 %, y al acabar `Voz local «sharvard» lista`. Mientras tanto Asistenta habla con la voz de siempre (SAPI o Piper); nada espera a la descarga.
- La descarga viene de la release oficial `tts-models` de sherpa-onnx, con URL y SHA-256 fijados en `src/voice/voz-local.ts`. Si el SHA-256 no coincide, se descarta. Si se corta, sigue donde se quedó. Se descomprime con el `tar` de Windows y se coloca de golpe en `state/models/tts/`.
- Sin red, se reintenta pasados 10 minutos, sin molestar.
- Detrás de un proxy, arranca Asistenta con `NODE_USE_ENV_PROXY=1` y `HTTPS_PROXY=…` (el `fetch` de Node lo respeta así).

En `.env`:

- `PA_TTS_LOCAL=kokoro` (por defecto): Kokoro-82M, la voz más natural (mujer, «ef_dora»). Son 350 MB que se bajan solos una vez; mientras bajan, si ya tenías sharvard, habla sharvard. En CPU va de sobra (~1 s por frase de 6 s con 4 hilos).
- `PA_TTS_LOCAL=kokoro-alex` o `kokoro-santa`: Kokoro con voz de hombre.
- `PA_TTS_LOCAL=sharvard`: la voz Piper castellana de antes (hombre), 80 MB.
- `PA_TTS_LOCAL=davefx`: la misma voz que Piper davefx, pero más rápida.
- `PA_TTS_LOCAL=off`: ni se descarga ni se usa; vuelve a SAPI/Piper como antes.
- `PA_TTS=sapi` o `PA_TTS=piper` también la apagan.

En Linux/macOS solo se activa si pones `PA_TTS_LOCAL`.

Si la voz local falla tres veces seguidas (por ejemplo, si el módulo nativo no carga en ese PC), Asistenta se queda con la voz de siempre hasta el siguiente arranque.

## Piper de respaldo (opcional)

La voz de respaldo es SAPI (Windows). Si SAPI no está o no tiene ninguna voz en español, las notas de voz salían con acento inglés o fallaban. Piper es un sintetizador neuronal **gratis y sin red**.

Está **apagado por defecto**. Para activarlo:

1. Descarga `piper` (https://github.com/rhasspy/piper/releases) y un modelo español, por ejemplo `es_ES-davefx-medium.onnx` (+ su `.onnx.json`).
2. En `.env`:
   - `PA_PIPER_MODEL=C:\voces\es_ES-davefx-medium.onnx`
   - `PA_PIPER_BIN=C:\piper\piper.exe` (si `piper` no está en el PATH)
   - `PA_TTS=piper` (opcional: usar siempre Piper)

Con `PA_PIPER_MODEL` puesto: si SAPI tiene voz española, SAPI va primero y Piper solo entra cuando SAPI falla; si no, Piper va primero y SAPI queda de respaldo.

## Licencias

`sherpa-onnx-node` es Apache-2.0; su binario nativo incluye espeak-ng (GPL-3.0) para pasar el texto a fonemas, igual que el propio Piper. Voces: `es_ES-sharvard-medium` (voz Piper de rhasspy entrenada con el corpus Sharvard de la Universidad de Edimburgo, https://datashare.ed.ac.uk/handle/10283/574, CC BY 3.0) y `es_ES-davefx-medium` (dataset CC0).

## La pantalla /voz del móvil

/voz ya no lee con la voz del iPhone: el PC sintetiza la respuesta con esta voz local y el móvil reproduce ese audio. Si el PC no puede (voz sin bajar y sin SAPI), el móvil vuelve a su propia voz.

No hay que bajar nada a mano: al arrancar, Asistenta descarga Kokoro sola (verás `Voz local «kokoro»: descargando 350 MB…` y luego `… lista`). Queda en la carpeta de modelos de Asistenta (`models/tts/kokoro-multi-lang-v1_0-…`, junto a los logs). Para volver a la voz anterior: `PA_TTS_LOCAL=sharvard` en `.env`.
