# Memoria de Asistenta

Todo lo que Asistenta recuerda vive en **una carpeta de tu PC**, en ficheros que puedes abrir y editar con el Bloc de notas:

`%USERPROFILE%\.local\share\personal-agent\memoria\`  (o `PA_STATE_DIR\memoria`)

| Fichero / carpeta | Qué es (tipo de memoria) |
|---|---|
| `indice.md` | Índice de lo que hay. Lo regenera Asistenta. |
| `PERFIL.md` | Hechos sobre ti (semántica). |
| `episodios/AAAA-MM-DD.md` | Diario: una línea por turno con lo que pediste y lo que contestó (episódica). |
| `procedimientos/<id>/SKILL.md` | Cómo-se-hace aprendidos (procedimental). |
| `notas/<tema>.md` | Hechos por tema: `salud`, `trabajo`, `casa`, `coches`, `finanzas`, `gerarai`, `amazon`, `musica`… y `general`. Cada línea lleva su `chat:`, así un grupo nunca ve lo de tu chat privado. |
| `sobre-ti.md` | Copia legible de tu perfil (la fuente es `profile/<id>.json`); se rehace en cada cambio. Si la editas a mano, tu versión se guarda en `sobre-ti.editado-<fecha>.md` antes de rehacerla. |

Sigue el artículo «The components of agent memory» (Anthropic, nov. 2026): las notas se escriben en el momento y una pasada nocturna («dreaming», `src/memory/consolidate.ts`) fusiona duplicados con copia previa y sin borrar hechos.

- **Escrituras:** la herramienta `memory` guarda, sustituye y olvida; cada escritura va a disco al momento.
- **Recuperación:** al empezar cada turno entran el perfil, el índice de notas relevantes (palabras clave y, con `PA_SEMANTIC_RECALL=1`, embeddings locales) y las habilidades. Todo local.
- **Seguridad:** nada que parezca una clave se guarda; las rutas no salen de la carpeta.
- **Migración:** la primera vez, `memory/`, `snapshot/PERFIL.md` y `skills/` se copian aquí verificados byte a byte; los originales quedan intactos en `memoria-copia/<fecha>/`. Si un fichero ya existía distinto, el viejo va a `memoria/_conflictos/`.
- **Telegram:** `/memoria` dice la ruta y un resumen por tipo.

## Notas por tema (`PA_MEMORY_TEMAS`, encendida)

- **Al escribir** el tema lo elige Asistenta (`tema` en la herramienta `memory`); si no lo dice, un clasificador local por palabras clave (`src/memory/temas.ts`, sin red) lo pone, y `general` si nada encaja. La pasada nocturna saca de `general` lo que ya encaja en un tema (mismo id, nada se borra).
- **Migración:** la primera vez, cada fichero por chat de `notas/` se reparte en temas. Antes se copian todos en `notas/_copia-por-chat/<fecha>/` (comprobado byte a byte) y después se comprueba que cada hecho está, igual, en su tema. Si algo falla, ese fichero se queda donde estaba (se sigue leyendo) y el error queda en `notas/_migracion-temas-error.txt`.
- **`indice.md`** lista cada tema con cuántos hechos vigentes tiene, al momento de cada escritura.
- **Telegram:** `/memoria` enseña lo de este chat agrupado por tema; `/memoria salud` enseña solo ese tema.
- `PA_MEMORY_TEMAS=0` vuelve a un fichero por chat (los temas ya escritos no se tocan).

## Privacidad del diario (`episodios/`)

Por defecto solo se apunta tu chat privado con Asistenta (y el panel). Lo que se dice en un grupo no va al diario. `PA_MEMORY_EPISODIOS_GRUPOS=1` incluye los grupos.
