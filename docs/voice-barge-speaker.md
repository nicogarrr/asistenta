# Brecha 3: barge-in fiable y verificación de hablante

Dos piezas de la voz en tiempo real. Estado actual: el **barge-in va activado
por defecto** en el nivel `altavoces` (se apaga con `/conversacion` o
`bargeIn: 'off'`); la **verificación de hablante sigue siendo opt-in**
(`PA_SPEAKER_VERIFY=1` + al menos una voz enrolada):

- **3a — Corte (barge-in) confirmado por forma.** El disparo por energía corta
  al agente con cualquier ruido sostenido por encima del gate (aspiradora,
  platos, tele). Con `bargeVad` (ya cableado en `src/cli.ts`) un candidato
  ruidoso se puntúa primero con Silero VAD y **solo el habla corta**. El nivel
  por defecto es `altavoces` (el usuario puede bajar a `off` o subir a
  `auriculares` con `/conversacion`). Novedad de esta PR: `scripts/barge-bench.ts` mide los falsos
  disparos **antes y después** con el modelo real v4.0 (sha256 verificado).
- **3b — Verificación de hablante (nuevo).** Solo las voces enroladas del hogar
  pueden mandar en la conversación por voz; una tercera voz no enrolada no
  llega ni al transcriptor. Módulo `src/voice/speaker-verify.ts`, puerta en
  `ConversationSession` (`speakerGate`), CLI `pa voice`.

## 3a — Medición de falsos disparos (bench real)

`BARGE_BENCH=1 npx vitest run test/barge-bench.test.ts` (descarga el modelo;
no es puerta de CI). Simula el camino de producción del nivel `auriculares`
(gate RMS=0.05, sustain=300 ms, umbral VAD=0.5, chunks de 100 ms).

Resultado en el sandbox del agente (2026-10-19, modelo real v4.0, fixtures
sintéticos deterministas + habla real: "hola" de Wikimedia Commons
`Es-hola.oga`, GFDL, ×8 → 2,6 s):

| fixture | segundos | cortes RMS | cortes RMS+VAD | prob VAD máx |
|---|---|---|---|---|
| ruido-blanco | 3.0 | 1 | 0 | 0.070 |
| aspiradora | 3.0 | 1 | 0 | 0.086 |
| platos | 3.0 | 3 | 0 | 0.276 |
| tele-musica | 3.0 | 3 | 0 | 0.046 |
| habla-sintetica | 3.0 | 1 | 1 | 0.828 |
| habla-real:hola-x8.pcm | 2.6 | 1 | 1 | 0.996 |

Sobre estos fixtures: el gate RMS solo habría cortado **8 veces por ruido**
(falsos disparos); la confirmación VAD los reduce a **0** y conserva el habla
(2/2). Es coherente con el spike A5 local (19/19 ruidos rechazados, 105/105
habla) pero **no lo sustituye**: falta el banco de audio real del hogar de Nico
(su tele, su aspiradora, conversaciones de fondo) — los fixtures sintéticos no
capturan música con voz (límite ya declarado en A5: pasajes orquestales
sostenidos le parecen voz al VAD, p95 0.92-0.98).

**Pendiente de medir en su PC:** FAR/FRR del corte sobre audio doméstico real
grabado (mismo protocolo de eventos que `wakeword-farfrr-bench.py`). El nivel
ya dejó de ser `off` por defecto (hoy `altavoces`); con la tabla de
`barge_sessions` toca vigilar la tasa de falsos disparos estimada y bajar el
nivel si en su casa se dispara en falso. La métrica de falsos disparos por
sesión (D1) ya existe y sigue contando.

## 3b — Verificación de hablante

```
pa voice enroll <nombre> <audio...>   # enrola/re-enrola (wav, mp3, ogg… vía ffmpeg)
pa voice verify <audio>               # puntuación contra los perfiles (exit 1 si rechaza)
pa voice list
pa voice remove <nombre>
```

- Activación: `PA_SPEAKER_VERIFY=1` **y** al menos un perfil enrolado. Sin
  perfiles la puerta queda desactivada con aviso en el log (una puerta que
  rechaza todo dejaría la voz muerta).
- La puerta corre **antes de whisper** sobre el audio capturado: una voz
  rechazada no se transcribe ni se contesta; la sesión sigue escuchando.
  Error de la puerta = **fail closed** (descarte + `lastError`). El texto de
  `submit()` (wake word "chochi, …" ya escuchada) no pasa por la puerta: ese
  audio ya pasó el detector de palabra de activación.
- Umbral/margen: `PA_SPEAKER_THRESHOLD` (defecto 0.62) y `PA_SPEAKER_MARGIN`
  (defecto 0.04). Cada rechazo se cuenta en `onSpeakerRejected`.
- Perfiles: vectores de 80 números en
  `STATE_DIR/voice/speaker-profiles.json` (no audio; no se puede reconstruir la
  voz; fichero 0600, escritura atómica).

### Extractor y sus límites (honesto)

El extractor por defecto es un embedding **log-mel** (40 bandas, 25 ms/10 ms,
pooling media+std, coseno): separa timbres claramente distintos y ruido sin
dependencias nativas. **No es un ECAPA-TDNN**: contra dos voces humanas
parecidas (misma familia, mismo acento) la frontera es más débil. La interfaz
`SpeakerExtractor` permite enchufar `spkrec-ecapa-voxceleb` (ONNX) sin tocar
perfiles ni puerta — queda pendiente de validar con voces reales.

**Verificado aquí:** mecánica completa con voces sintéticas deterministas
(intra-hablante > inter-hablante con margen, rechazo de ruido, persistencia,
fail-closed en la conversación, `submit()` sin puerta) y tipo/compilación.

**Pendiente en el PC de Nico:** enrolar a Nico y a la segunda persona del
hogar con muestras reales (`pa voice enroll`), ajustar umbral con
`pa voice verify` sobre grabaciones de ambos y de una tercera voz, y solo
entonces activar `PA_SPEAKER_VERIFY=1`. Las muestras de la segunda persona
aún no existen (pendiente desde 2026-10-14).
