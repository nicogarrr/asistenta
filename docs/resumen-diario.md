# Resumen de la mañana

Apagado por defecto. Con `PA_BRIEFING=1` Asistenta manda cada día, al DM del dueño
verificado, un resumen corto: agenda de hoy, hasta 3 correos sin leer que parecen
importantes (solo remitente y asunto; fuera boletines y promociones), rutinas y
recordatorios que tocan hoy, seguimientos vencidos y, si se configura, el tiempo.

| Variable | Por defecto | Qué hace |
| --- | --- | --- |
| `PA_BRIEFING` | apagado | `1` lo enciende |
| `PA_BRIEFING_HOUR` | `8` | hora local a partir de la que se manda |
| `PA_BRIEFING_LAT` / `PA_BRIEFING_LON` | sin tiempo | coordenadas para el tiempo (Open-Meteo, gratis y sin clave) |
| `PA_BRIEFING_PLACE` | vacío | etiqueta de la línea del tiempo («Madrid») |

Ritmo, para que no sea spam (`src/briefing-daily.ts`):

- Una vez por día natural; se recupera si el PC estaba apagado a las 08:00.
- Si el PC despierta después de las 12:00 sin haberlo mandado, el de hoy se salta.
- Un día sin nada no manda «no tienes nada».
- Una fuente lenta (calendario, IMAP, tiempo) se omite a los 15 s y el resto sale.
- Si Telegram falla, se reintenta en el siguiente tick (10 min) hasta las 12:00.

`/resumen hoy` lo pide al momento (solo en el chat privado del dueño). `/resumen` sigue
siendo el resumen semanal.

## Objetivos y precios

El resumen incluye también tus **objetivos** activos (con el siguiente paso) y bloqueados (primero, con el motivo), y tus **vigilancias de precio** con objetivo o % de bajada (último precio leído; las que ya están por debajo del objetivo van primero). Un objetivo en marcha o un precio sin novedad no bastan para enviar el resumen; un objetivo bloqueado o un precio ya bajo el objetivo, sí.

## Resumen en voz

`PA_BRIEFING_VOZ=1` (apagado por defecto, solo en el PC con voz) manda además el resumen como nota de voz justo después del texto. La voz nunca retrasa el texto: tiene un tope de 20 s y, si falla, solo se pierde el audio.
