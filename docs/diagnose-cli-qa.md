# Diagnóstico local desde la consola

`pa diagnose` usa el informe existente de `src/diagnose.ts`; `pa diagnose --json` imprime los mismos datos estructurados. El comando no carga configuración ni desbloquea el vault, no llama al modelo ni a Telegram y no arranca, mata o reinicia procesos. Las aprobaciones se abren expresamente en modo de solo lectura. Las opciones desconocidas devuelven código 2 con el uso en español.

Si el estado no existe o está incompleto, se imprime el informe con sus limitaciones y código 0: indica que se produjo el informe, no que el daemon esté sano. No crea el directorio de estado ni repara archivos dañados. El informe puede contener rutas, destinos y mensajes privados de los logs locales; no se envía ni se publica automáticamente.

Verificación: 16 pruebas dirigidas (módulo existente y comando), typecheck, build y Biome pasan. Incluye ejecución real del CLI compilado con estado temporal vacío y red Docker deshabilitada, sin credenciales ni sesión de Nico; JSON válido, estado sin crear, aprobaciones sin cambio de bytes ni ficheros añadidos y pid ilegible intacto. No es una prueba del daemon de Windows ni instala un watchdog. No cierra los pendientes de setup, status/stop/restart o vigilancia automática.
