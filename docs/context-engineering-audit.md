# Auditoría de context engineering (27-oct-2026, sobre main b905fb7)

Alcance: todo lo que compone el contexto de cada petición del agente — prompt de
sistema, nota de contexto por turno, herramientas, historial y compactación — y
la caza de bugs en ese camino. Medido sobre el checkout real; los tests citados
son los que corren en `npm test`.

## Capas y su coste máximo por petición

| Capa | Tope real | Dónde |
| --- | --- | --- |
| Prompt de sistema | 9.416 chars (~2.354 tokens); +539 chars en modo servidor | `src/core/prompt.ts` |
| Definiciones de herramientas | browser+media diferidas hasta que el mensaje las pide (patrón palabra clave o `cargar_herramienta`) | `src/core/toolset.ts` |
| Nota de contexto (memoria) | índice: 5 recientes completas + filas de 80 chars, capa 4.000 chars con degradación en dos fases | `src/memory/context.ts` |
| Nota de contexto (perfil+memoria) | 6.000 chars por bloque | `src/memory/prompt.ts` |
| Nota de contexto (skills) | 20 filas × 110 chars; pasos bajo demanda con `skills read` | `src/skills/lessons.ts` |
| Nota de contexto (historial) | 4 sesiones × 200 chars | `buildContextNote` en `src/cli.ts` |
| Resultado de herramienta | 24.000 chars por resultado (cabeza+cola); los 6 más recientes íntegros, el resto recortado a 300 | `src/core/agent.ts` |
| Imágenes | 3 recientes; las antiguas se sustituyen por placeholder (solo en la copia de la petición) | `src/core/agent.ts` |
| Compactación | dispara a 60.000 tokens estimados, conserva ~20.000 recientes; resumen iterativo con cerca `<<<DATOS` y escape de saltos de línea | `src/core/history.ts` |
| Presupuesto de iteraciones | por petición (nunca arrastra sobrantes), con presión visible al 30%/10% | `src/core/budget.ts`, `src/core/router.ts` |

## Hallazgo corregido

**El texto guardado por el agente podía cerrar las cercas de la nota de contexto.**
Los bloques `<memory>`, `<historial>`, `<workstreams>` y `<routines>` interpolaban
texto almacenado (un hecho de memoria, el resumen de una sesión —que es una
respuesta pasada del agente—, un frente de trabajo, el nombre de una rutina) sin
neutralizar el marcado. Ese texto pudo originarse en una web o en un resultado de
herramienta; un valor con `</historial>`, `</memory>`, etc. rompía la cerca y se
hacía pasar por marcado del prompt en TODOS los turnos siguientes. `skillsIndex`
ya se defendía de esto para `<skills>` ("a skill cannot close the <skills> block
or pose as markup"); los demás bloques no.

Fix: `plainInline()` en `src/utils.ts` (quita `<`, `>` y backtick, solo en el
render; lo almacenado no se reescribe) aplicado en `renderMemoryContext`,
`WorkstreamStore.index` (vía `oneLine`), `<historial>` y `<routines>` de
`buildContextNote`. `skillsIndex` refactorizado para usar la misma función (una
sola definición de la defensa).

Pruebas: `test/context-note-fences.test.ts` — 5 tests (4 negativos e2e sobre
`buildContextNote` real + unidad de `plainInline`). Los 4 negativos fallan sin el
fix (verificado con stash sobre b905fb7) y pasan con él; lo almacenado queda
intacto (aserción explícita).

## Revisado sin hallazgos (con la defensa existente)

- Compactación (`history.ts`): corte nunca entre llamada y resultado, transcript
  de una línea por mensaje con TODOS los saltos escapados (LF, CR, U+2028/29),
  cerca `<<<DATOS` anti-falsificación, extracción de hechos con dedupe conservador
  de números. Cubierto por `test/history.test.ts` y `test/context-limits.test.ts`.
- Memoria: hechos superados nunca se renderizan ni se devuelven en
  get/recall/list (`test/memory-drilldown.test.ts`); tags con charset seguro.
- Router y presupuesto: clasificación determinista coste 0 con override `n1:`–`n4:`,
  techo por nivel que nunca crece; presión "de esta tarea" (`test/router.test.ts`,
  `test/budget.test.ts`).
- Carga diferida de herramientas con red de seguridad (`cargar_herramienta`
  siempre presente; lo cargado no se descarga) — `test/toolset.test.ts`.
- Importación de skills: https estricto, tope de bytes, redirecciones
  revalidadas, filtro de frases de inyección y de secretos — `test/skills-import.test.ts`.

## Considerado y excluido

- Bloque `<perfil>`: sus hechos solo entran por `/perfil guardar` del propietario
  (`source: 'user'` en `cli.ts`), canal confiable; neutralizar el marcado cambiaría
  lo que el propietario ve de sus propios hechos. Si algún día una herramienta del
  agente escribe perfil, aplicar la misma defensa en `OwnerProfile.render()`.
- `truncateOldImages`/`pruneOldToolResults` descartan mensajes malformados (no
  objeto) en la copia de la petición: pi nunca los produce; anotado por si el
  proveedor cambia.
