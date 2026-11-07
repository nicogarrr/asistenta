# Memoria de Asistenta

Todo lo que Asistenta recuerda vive en **una carpeta de tu PC**, en ficheros que puedes abrir y editar con el Bloc de notas:

`%USERPROFILE%\.local\share\personal-agent\memoria\`  (o `PA_STATE_DIR\memoria`)

| Fichero / carpeta | Qué es (tipo de memoria) |
|---|---|
| `indice.md` | Índice de lo que hay. Lo regenera Asistenta. |
| `PERFIL.md` | Hechos sobre ti (semántica). |
| `episodios/AAAA-MM-DD.md` | Diario: una línea por turno con lo que pediste y lo que contestó (episódica). |
| `procedimientos/<id>/SKILL.md` | Cómo-se-hace aprendidos (procedimental). |
| `notas/*.md` | Hechos guardados por chat o tema. |

Sigue el artículo «The components of agent memory» (Anthropic, nov. 2026): las notas se escriben en el momento y una pasada nocturna («dreaming», `src/memory/consolidate.ts`) fusiona duplicados con copia previa y sin borrar hechos.

- **Escrituras:** la herramienta `memory` guarda, sustituye y olvida; cada escritura va a disco al momento.
- **Recuperación:** al empezar cada turno entran el perfil, el índice de notas relevantes (palabras clave y, con `PA_SEMANTIC_RECALL=1`, embeddings locales) y las habilidades. Todo local.
- **Seguridad:** nada que parezca una clave se guarda; las rutas no salen de la carpeta.
- **Migración:** la primera vez, `memory/`, `snapshot/PERFIL.md` y `skills/` se copian aquí verificados byte a byte; los originales quedan intactos en `memoria-copia/<fecha>/`. Si un fichero ya existía distinto, el viejo va a `memoria/_conflictos/`.
- **Telegram:** `/memoria` dice la ruta y un resumen por tipo.
