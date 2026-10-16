# Control local: primitiva Linux, no integración de producto todavía

Esta PR añade una primitiva y sus canarios. **No registra `pa stop` ni `pa restart`, no cambia lifecycle ni instala un watchdog.** No se ha abierto un endpoint en el daemon de Nico. El cableado queda para otra revisión después de auditar esta base.

- Solo Linux. En cualquier otra plataforma falla antes de leer estado. Windows requiere DACL del SID esperado y pipe local con ACL verificada; `mode: 600` no lo sustituye.
- Directorios de estado/control privados (700, propietario actual, lstat sin symlink), metadata/lock privados y socket 600. Un estado existente abierto a otros usuarios se rechaza, no se corrige silenciosamente.
- Cerradura OS con `flock --exclusive --nonblock 4` sobre un descriptor heredado. El padre conserva ese descriptor abierto hasta cerrar el control; el kernel libera al terminar el proceso, incluso ante crash. El archivo de lock nunca se borra. Sin `flock`, falla cerrado. No toma un PID como prueba de propiedad y nunca envía señales a un PID de metadata.
- Metadata READY publicada con temporal exclusivo y rename después de abrir el socket, únicamente tras `ready()`. Token nuevo de 256 bits, fuera de logs, argumentos y variables de entorno. Los mensajes de error no incluyen contenido de metadata.
- Autenticación mutua HMAC SHA-256: challenge del servidor, nonce cliente, versión/dominio/instanceId/acción y estado ligados a las pruebas; comparación constante. El secreto no circula por el socket. Un socket falso no recibe la petición autenticada si no demuestra conocer el secreto.
- Solo status/stop, una petición por conexión, máximo 2048 bytes y 2 segundos por etapa, máximo 8 clientes. Una parada repetida no ejecuta dos veces el callback. ACK STOPPING significa aceptado, nunca apagado confirmado. `close()` se debe llamar **después** de acabar el shutdown, no al aceptar la solicitud.
- Stale metadata solo se inspecciona bajo la cerradura OS, nunca por un timeout aislado. Socket derivado del instanceId, no de un campo endpoint aportado por metadata. Si el archivo anterior es ambiguo o no es un socket propio, no se borra. Cleanup comprueba que sigue siendo propietario; no borra metadata de otra instancia.

## QA

16 pruebas dirigidas verdes con Node 24 y Linux: concurrencia de dos arranques, ACK/status sin secreto, doble stop y bloqueo mantenido hasta close, READY explícito, PID alterado no usado como autoridad, token antiguo, permisos/symlink, endpoint remoto ignorado, socket abierto, slowloris/oversize, ACK falsa, replay bajo challenge nuevo, metadata sustituida, archivo regular donde debería haber socket, metadata dañada y demasiado grande, crash antes y después de publicar. Los fixtures de crash son hijos propios recién creados; no se usa el PID de un archivo para matarlos. Estas pruebas se omiten fuera de Linux, no sustituyen QA Windows.

Typecheck y build: por verificar al publicar. Suite completa fresca: pendiente. No se afirma cobertura de los escenarios de restart/lifecycle, que todavía no se implementan aquí. El callback es inyectado, no se vende como integración real.

## Contrato que falta en el cableado

Adquirir propiedad antes de limpiar PID o abrir herramientas, publicar READY al final del arranque, ejecutar lifecycle.stop una sola vez, mantener la cerradura hasta que terminen herramientas/Telegram/BD y se registre si el cierre fue limpio o agotó los 15 segundos. Restart debe serializar parada y arranque, esperar la liberación real, impedir relanzar una copia si otro supervisor la lanzará y confirmar READY autenticado de una instancia distinta. Sin prueba del modo de supervisión, restart debe negarse. Nunca sustituir esto por un kill al vencer un timeout.

## Fuentes técnicas

- https://man7.org/linux/man-pages/man2/flock.2.html : la cerradura está asociada a la open file description, compartida por descriptores duplicados/heredados y liberada al cerrar todos.
- https://man7.org/linux/man-pages/man1/flock.1.html : forma sobre descriptor, exclusión no bloqueante.
- https://nodejs.org/docs/latest-v24.x/api/net.html : sockets locales Unix, límites, cierre y APIs públicas.
- https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights : por qué Windows requiere ACL explícita, no permisos Unix.
