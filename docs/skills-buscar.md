# Buscar skills (`/skills buscar`)

`/skills buscar <texto>` busca en un índice JSON que tú eliges y responde con nombre, descripción corta y URL de cada skill (máximo 10). No descarga ni instala nada: para instalar una, `/skills instalar <url>`, que sigue con la revisión estricta de siempre.

Configuración en `.env`:

```
PA_SKILLS_INDEX_URL=https://raw.githubusercontent.com/<usuario>/<repo>/main/skills.json
```

Formato del índice: `[{ "name": "...", "url": "https://.../SKILL.md", "description": "..." }]` (o `{ "skills": [...] }`).

- Solo https (también tras redirecciones); URLs con usuario/contraseña se descartan.
- Plazo de 15 s y 1 MB como máximo.
- Sin `PA_SKILLS_INDEX_URL`, el comando explica cómo configurarlo.
