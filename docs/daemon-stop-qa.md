# Parada local autenticada en Linux

`pa stop` solicita parada por el endpoint autenticado de la instancia, espera el drenaje y verifica una prueba final HMAC ligada al instanceId, más liberación real de la cerradura OS. ACK STOPPING no es éxito. No mata por PID, no arranca otra copia y no solicita modelos, Telegram ni datos de cuenta.

`pa restart` se rechaza sin tocar el daemon porque el repositorio aún no proporciona evidencia fiable del supervisor que lo relanzaría. No se presenta restart como implementado. Windows conserva su arranque actual, sin endpoint de control ni stop nuevo: DACL/pipe verificados siguen pendientes. Linux requiere `flock`, directorio de estado privado y longitud compatible con sockets Unix.

## Cableado

La misma propiedad cubre `chat` y `serve`, antes de assertNotRunning y su limpieza de PID. El directorio nuevo se crea con 700; los directorios existentes con permisos abiertos se rechazan sin cambiarlos. Si necesitas migrar uno, revisa propietario/contenido y restringe manualmente su acceso antes de arrancar; no se ha modificado la máquina de Nico.

READY se publica después de conectar lifecycle y acabar el arranque. La parada de serve corta avisos, inicia el cierre de polling Telegram, aborta acciones y espera los drenajes y recursos ya presentes antes de terminar. Chat aborta su turno y espera su resultado, cierra readline y recursos. El heartbeat se detiene al acabar el cierre.

Un error de cierre registra resultado no limpio y conserva la propiedad hasta salir del proceso; si quedan recursos vivos, un límite fatal de 15 segundos evita una espera sin fin. Un fallo antes de instalar lifecycle tampoco libera propiedad para permitir otro daemon junto a recursos sin drainer: conserva lock hasta salida fatal en 15 segundos. No se declara resultado limpio por timeout ni por desaparición del socket. El hard-exit de lifecycle sigue registrando el marcador stale y no produce prueba limpia.

La prueba final está en un archivo privado propio por instancia. Contiene instanceId, booleano clean y HMAC; no contiene token. Su acumulación es una deuda de retención acotada pendiente de diseñar sin borrar evidencia que aún consulta un cliente. El callback limpio significa que terminaron los drenajes declarados, no que se ha verificado salud del modelo ni que el proceso OS ya desapareció. Stop verifica propiedad liberada; no usa un PID para concluir esto.

## QA

Pruebas con procesos hijos propios y lifecycle real, sin credenciales reales ni cuenta/sesión de Nico: parada posterior al drenaje, CLI stop compilado, fallo de shutdown no limpio/stale, hard-exit no limpio, rechazo restart sin tocar instancia, lock retenido durante error con recurso que sigue vivo y PID antiguo sin metadata no tocado. Se ejecutan en la fase serial de recursos. Las primitivas HMAC, concurrencia, permisos y crash de #170 siguen cubiertas por sus 16 canarios.

No se presenta como prueba Telegram real ni de un daemon completo de producción. Falta QA nativa Windows y un supervisor con autoridad de restart. Fresh suite completa y auditoría independientes: pendientes al publicar borrador.
