# Copias de seguridad

Asistenta hace una copia diaria del estado en `<estado>/backups/AAAA-MM-DD/` (bases `.db`/`.sqlite`, memoria, skills, perfil, agenda local, JSON de configuración) y guarda las últimas.

- `pa backup` — lista las copias, la más reciente primero.
- `pa backup restaurar <AAAA-MM-DD|ultima>` — restaura una copia. Para antes el daemon (`pa stop`). Lo que había se mueve a `backups/antes-de-restaurar-<marca>/` (deshacible) y se apartan los `-wal`/`-shm` de las bases restauradas.
