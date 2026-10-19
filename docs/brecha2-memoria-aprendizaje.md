# Brecha 2: memoria semántica, mejora de skills en uso y modelo de usuario

Cierre de la brecha de memoria/aprendizaje frente a Grok/Hermes/Muse. Coste 0:
todo corre local (onnxruntime-node, el mismo runtime que Whisper en stt.ts) y
ningún texto sale de la máquina.

## 1. Memoria de 3 niveles (ítem 9 del ROADMAP)

Estado: **ya estaba en main** (9a bench en `scripts/memory-bench.ts`, 9b índice
en `src/memory/context.ts`, 9c timeline en `src/memory/timeline.ts`, cableados
en `cli.ts` y `tools/memory.ts` con `action=timeline`). Este PR lo verifica con
su batería (137 tests del grupo memory/skills verdes) y añade la pieza que el
bench 9a marcaba como pendiente: el recall léxico fallaba en parafraseados.

## 2. Recall semántico (S5) — opt-in `PA_SEMANTIC_RECALL=1`

`src/memory/semantic.ts`: embeddings locales con
`Xenova/paraphrase-multilingual-MiniLM-L12-v2` (q8, CPU, multilingüe es/en) vía
`@huggingface/transformers` (dependencia ya presente). El modelo se descarga al
directorio de modelos en el primer uso, igual que Whisper.

- Híbrido, nunca sustituto: `score = léxico + 4*coseno`. Lo léxico sigue
  ganando en coincidencias exactas; el coseno rescata parafraseados.
- Cableado en `memory action=recall` y `skills action=search` (skills y
  lecciones, que son skills de categoría `lecciones`).
- Si el embedder falla (modelo sin descargar, nativo roto) el recall cae al
  léxico de siempre con un warn en el log. Nunca rompe un chat.
- Apagado por defecto: la primera descarga (~50 MB) no debe pillar por
  sorpresa en mitad de una conversación. Se activa con
  `PA_SEMANTIC_RECALL=1` en `.env`. Verificado en sandbox solo con embedder
  falso; el modelo real se verifica en el PC (pendiente, ver abajo).

## 3. Mejora de skills durante el uso (bucle Hermes)

`src/skills/refine.ts`: cuando una lección auto-guardada (`Si X falla, probar
Y`, categoría `lecciones`) reaparece (su versión cuenta reincidencias, umbral
2), se anota al momento en el skill afectado — "Lección aplicada en uso
(fecha): si X falla, prueba Y" — vía `save()`, que conserva pasos, notas y el
rastro de cambios. No espera al evolve semanal, nunca reescribe pasos, es
idempotente y nunca lanza. Activo por defecto: solo escribe Markdown auditable
y editable a mano.

## 4. Modelo de usuario auto-enriquecido, visible y borrable

`src/memory/usermodel.ts`: un `NudgeTracker` cuenta en cuántos días distintos
se ha detectado el mismo hecho duradero (los nudges ya corren en cada mensaje).
Al tercer día deja de ser pregunta: se guarda solo en el perfil con marca
`[auto]` y el usuario lo oye una vez ("dímelo y lo borro").

- Visible: `memory action=profile` (entra por el mismo `appendEntry`).
- Borrable: nueva `memory action=forget_profile` con
  `snapshot.removeEntries(query)` — quita las entradas del perfil que
  contienen el texto, sin distinguir mayúsculas ni acentos. También sirve para
  lo que el usuario pida olvidar del perfil ("olvida eso de tu perfil").
- Antes del umbral (3 días distintos) se pregunta como siempre; tras
  autoguardar, no se vuelve a contar, así que borrarlo no lo resucita.
- El filtro de secretos sigue delante de cualquier escritura.

## Verificación

- `npm run typecheck`, `npm run lint:check`, `npm run build`: verdes en sandbox.
- Tests nuevos: `test/semantic.test.ts` (8), `test/skill-refine.test.ts` (3),
  `test/usermodel.test.ts` (4). Suites tocadas re-corridas: memory, skills,
  lessons, cli-wiring, timeline, snapshot (137 tests, verdes).
- **No verificado aquí**: descarga real del modelo de embeddings y su latencia
  en el PC (sandbox sin red a HF en CI; la ruta de carga replica stt.ts). Con
  el flag apagado nada cambia respecto a main. Suite completa y Windows: CI.
