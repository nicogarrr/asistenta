# Correo por IMAP IDLE (fase 2, depende del filtro de eventos)

Se mantiene una conexión TLS al IMAP ya configurado, abre INBOX con EXAMINE read-only y
recibe EXISTS. No usa Google Pub/Sub, nuevas cuentas, servicios de pago ni claves nuevas.
No SMTP, STORE, EXPUNGE, borrado ni flags de lectura. ImapFlow obtiene el source con
BODY.PEEK; se limita a 32 KiB por correo y el modelo recibe como máximo 6000 caracteres.
No decodifica MIME nuevo: reutiliza el parser actual, con sus límites en HTML/base64.

Primer arranque: guarda UIDVALIDITY y UIDNEXT como base sin recorrer el buzón anterior.
Cambio de UIDVALIDITY, cursor corrupto o UIDNEXT retrocedido: nueva base, nunca interpreta
los UIDs viejos en el nuevo epoch. Esto puede omitir correo llegado durante el reset;
es preferible a reavisar todo el buzón. En reconexión ordinaria recupera UIDs pendientes,
incluso si EXISTS no cambió. Clave por host/puerto/cuenta/carpeta, cursor en store local.
Usa ID estable de Gmail/OBJECTID si existe; fallback UID incluye UIDVALIDITY.

EXISTS puede NO terminar IDLE. El listener despierta su propia espera y el siguiente
EXAMINE interrumpe el IDLE mediante la cola de ImapFlow. Revalida UIDVALIDITY antes de leer.
El cursor avanza solo tras aceptación SQLite por el filtro; si está apagado, sin owner,
o la cola está llena, conserva el UID y reconecta con backoff, sin perderlo silenciosamente.
No se duplican los eventos del barrido de correo anterior: ese barrido sigue alimentando
la agenda, pero deja de inyectarlos al filtro. Calendario sigue su cadencia existente.

Backoff de reconexión: 30s, 60s, 120s hasta 1h; se reinicia tras conexión estable >60s.
IDLE se renueva cada 25 minutos, no se buscan correos por timer. Si falta capacidad IDLE,
se detiene como unsupported y NO usa la emulación NOOP con sondeo frecuente de la librería.
Cada operación tiene límite 30s, apagado aborta y cierra socket, no deja timer de reconexión.
Fallos registrados con estados genéricos sin contenido remoto ni credenciales.

## Pruebas

Mocks de protocolo, no Gmail real: reconexión con correo perdido, UIDVALIDITY en nueva
conexión y en conexión existente, base inicial, false read-only, IDLE ausente/roto, ráfaga
por bloques de 25 UIDs, UIDs fuera de rango, UID incorrecto, aceptación fallida, shutdown
con IDLE y connect colgado. Filtro prueba aceptación durable. Repetir con Node 24:

```
npm run typecheck
npm run build
npx vitest run test/mail-idle.test.ts test/ojo-events.test.ts test/mail*.test.ts test/vigilante*.test.ts test/ojo*.test.ts test/provider*.test.ts
```

No se ha conectado a Gmail real en esta prueba. Piloto debe comprobar cuenta configurada,
capacidad IDLE, logs connected, llegada controlada, flags sin cambiar y reconexión real.
No afirmar latencia de segundos medida hasta hacerlo. Los cuerpos pueden quedar en SQLite
hasta procesarse o caducar; la política de la fase 1 conserva dedupe sin cuerpo después.
