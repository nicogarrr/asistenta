# #106 ronda 2 - plan de correccion (12 puntos auditor)
Repros del auditor: fichero /downloads/vigilante-audit.test-bbf8ccf1.ts en el sandbox (6 tests).
Convenciones de src/agenda/unified.ts (bullet): titulo cap 90 chars colapsando whitespace,
allDay -> "todo el dia", timed===false -> "sin hora", tag fuente WHERE_TAG, duda
` (NN% seguro)` si confidence<0.8. zonedDayKey/zonedDayStart de src/agenda/ics.ts.
allowedUserIds en cli.ts variable `allowed` (vault telegram:allowedUserIds, ~linea 1059).
localTimeZone(): PA_TIMEZONE env o sistema; en node:24-alpine = UTC salvo env.
OJO test auditor: findingKey(a) sin TZ debe mapear 00:30+02 y 14:00+02 al mismo dia ->
default localTimeZone(); si falla en Alpine, correr vitest con PA_TIMEZONE=Europe/Madrid.

1. Cap DESPUES de known: collectFindings sin slice; runVigilanteOnce: dedupe intra-barrido
   por findingKey -> filtrar known -> slice(maxItems).
2. formatFindings: allDay -> "todo el dia"; timed===false -> "sin hora"; nunca hora inventada.
3. findingKey(item, timeZone=localTimeZone()): usa zonedDayKey(at, timeZone) en vez de
   toISOString (UTC). 'sin-fecha' si at==null.
4. collectFindings incluye pending: at!=null, at >= zonedDayStart(now,tz) (no overdue),
   at < horizon (= zonedDayStart(tomorrow + agenda.days*DAY_MS, tz) como unified.ts).
5. formatFindings: tag fuente (item.sources join '+' o WHERE_TAG[where]) + duda confidence<0.8.
6+12. Nuevo export puro resolveOwnerDmChatId(chatKeys: Iterable<string>, allowedUserIds: number[]):
   solo channel==='telegram', chatId numerico >0 (grupos negativos fuera), chatId en allowed;
   exactamente 1 candidato o null (FAIL CLOSED). cli.ts lo usa con `allowed`; send devuelve
   false+log si null.
7+8. startVigilanteLoop: stop(): Promise<void> - stopped=true, clearTimeout, await in-flight.
   deps.shouldAbort?: () => boolean chequeado ANTES de send y ANTES de persist en runVigilanteOnce.
   cli.ts: `await vigilante.stop()` antes de store.close()/memoryDb.close().
9. Dedupe intra-barrido: Map por findingKey antes del known-filter.
10. Comentario honesto: envolver cuerpo de runVigilanteOnce en try/catch -> "nunca lanza" verdad.
11. Titulo cap 90 en formatFindings (NO cap 4000; telegram ya chunkea).
Tests a anadir (mios, ademas de los 6 repros del auditor verdes):
   resolveOwnerDmChatId: grupo rechazado, no-allowlist rechazado, 2 DMs -> null, 0 -> null, 1 -> ok.
   pending overdue excluido; pending sin fecha excluido; pending en ventana incluido.
   shouldAbort antes de persist; formato allDay/sin hora; duda confidence; cap titulo 90.
Verificacion: biome+tsc+vitest en node:24-alpine (montar node_modules de ~/wt-openrouter),
PA_TIMEZONE=Europe/Madrid si findingKey falla por TZ del contenedor.
Luego: commit (atribucion fija), push feat/vigilante, diff nuevo al padre con head SHA.
