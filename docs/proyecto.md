# Carpetas de proyecto (`/proyecto`)

Liga una carpeta a la conversación y su `ASISTENTA.md` (o, si no hay, `AGENTS.md`) entra en el contexto en cada turno. Así no repites «usa pnpm», «los tests van con vitest» o «no toques producción» cada vez que hablas de ese proyecto.

- `/proyecto C:\Users\nico\web` liga la carpeta (comillas permitidas si la ruta lleva espacios).
- `/proyecto` muestra qué está ligado y si se está cargando.
- `/proyecto quitar` la desliga.

Límites:
- Solo el dueño, en su chat privado; el bloque solo entra en ese chat (como el perfil).
- La carpeta tiene que estar dentro de `PA_PROJECT_ROOTS` (rutas separadas por `;`; por defecto tu carpeta de usuario; `off` apaga la función). Un enlace simbólico que apunte fuera no vale.
- Como mucho 4 KB. El texto pasa los mismos filtros que un skill importado (secretos, URLs con token, frases de inyección): si no pasa, no se carga y `/proyecto` dice por qué.
- Se relee en cada turno: editar el fichero vale sin religar. Las instrucciones son contexto; no dan permisos nuevos.
