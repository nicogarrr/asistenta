# Filtro de relevancia de eventos (fase 1)

Dos pasos sin herramientas: filtro estricto y segunda revisión independiente. Solo una
señal con puntuación >=0,85 y cita literal verificable en el evento puede generar aviso.
El texto del aviso es fijo y deja claro que no confirma un error. El contenido externo
no autoriza acciones. Nada se envía a terceros ni se borra o marca leído en Gmail.

Reutiliza el proveedor existente: OpenRouter con modelo `:free` en su endpoint exacto,
o OpenCode local en loopback con modelo `-free`. Cualquier otro proveedor o fallback
no gratuito desactiva esta función. No abre cuentas, no obtiene claves ni activa pago.
Si existe un fallback gratuito configurado, lo usa para el filtro; si no, usa el mismo
modelo con esfuerzo bajo. No asegura que haya un modelo más pequeño o más inteligente:
eso depende de la configuración y de su disponibilidad real, aún no probada en el PC.

## Ritmo y persistencia

- Como máximo 20 llamadas de modelo por hora móvil (también cuentan errores).
- 4 intentos de aviso por 24 horas móviles y 30 minutos de separación.
- Silencio 22:00-08:00 en la zona del usuario, sin excepciones nuevas.
- Dedupe por fuente e identidad estable en SQLite, conservado 7 días entre reinicios.
- Cola máxima de 100 eventos, texto máximo 6000 caracteres, caducidad 24 h.
- Eventos ya procesados no conservan cuerpo; pendientes caducados borran su cuerpo.
- Solo DM del owner verificado, respeta `/ojo off`, drain/abort al apagar.
- Cada evento tiene deadline de 25 s para ambas fases. Envío acotado a 10 s.
- Un envío fallido o ambiguo consume el intento y NO se repite automáticamente.
  Es una elección anti-duplicados: puede perderse una alerta si Telegram falla.

## Integración y lo que falta

`AttentionQueue.offer()` es el punto de entrada para eventos, sin polling propio.
En esta fase lo llaman las entregas de correo/calendario del ojo existente, cada 30 min.
Las reuniones entran cuando se descubren a menos de 2 h, no mediante un timer nuevo.
NO hay Gmail push/IMAP IDLE todavía: no promete detección inmediata. No acelera el sondeo.
No se modifican las funciones IMAP/SMTP ni sus flags. Sin el daemon y el proveedor free
operativos no hay avisos reales. Las pruebas usan mocks, no la cuenta de Nico.

La relevancia es heurística del modelo, no una certeza. Una compra talla S por sí sola
NO es un error: se exige contradicción explícita y se prohíbe inventar preferencias.
Esta fase no lee memoria personal de tallas ni relaciona compras entre varios correos.

## Verificación antes de activar en producción

En Node 24: `npm ci`, `npm run typecheck`, `npm run build`, y
`npx vitest run test/ojo-events.test.ts test/vigilante*.test.ts test/ojo*.test.ts test/mail*.test.ts test/provider*.test.ts`.

Después de review/CI y despliegue del piloto, verificar una fuente real y que su proveedor
siga ofreciendo los modelos free; no presentar tests simulados como eficacia real medida.
