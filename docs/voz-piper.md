# Voz local de respaldo con Piper (opcional)

La voz por defecto es SAPI (Windows). Si SAPI no está o no tiene ninguna voz en español, las notas de voz salían con acento inglés o fallaban. Piper es un sintetizador neuronal **gratis y sin red**.

Está **apagado por defecto**. Para activarlo:

1. Descarga `piper` (https://github.com/rhasspy/piper/releases) y un modelo español, por ejemplo `es_ES-davefx-medium.onnx` (+ su `.onnx.json`).
2. En `.env`:
   - `PA_PIPER_MODEL=C:\voces\es_ES-davefx-medium.onnx`
   - `PA_PIPER_BIN=C:\piper\piper.exe` (si `piper` no está en el PATH)
   - `PA_TTS=piper` (opcional: usar siempre Piper)

Con `PA_PIPER_MODEL` puesto: si SAPI tiene voz española, SAPI va primero y Piper solo entra cuando SAPI falla; si no, Piper va primero y SAPI queda de respaldo.
