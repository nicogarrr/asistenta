# Superficies a €0: correo propio y WhatsApp (evaluación)

Estado: correo YA existe (fases 1-4: lectura, IMAP IDLE, credencial aislada, respuesta con
aprobación). Esta rama añade `/correo estado` (qué falta, sin valores). WhatsApp: NO se construye.

## Correo con la cuenta Gmail de Nico

- Ya hecho: avisos por IMAP IDLE, `/correo lista`, respuesta solo bajo petición y con aprobación
  cada vez. Ver `mail-idle.md` y `mail-reply.md`.
- `/correo estado` (solo DM del dueño) dice si `mailRead` y `mailSend` están configurados,
  son válidos y son la misma cuenta. No muestra ni la dirección ni la contraseña.
- Falta el secreto: nada se activa solo. Pasos para Nico, en su PC: crear una contraseña de
  aplicación NUEVA de Google (16 letras) y guardarla con `node dist/cli.js vault set-stdin
  mailRead:password` por pipe privado (ver `vault-stdin-qa.md`), más `mailRead:address`. No se
  manda por chat. Sin ella, la función queda apagada, no rota.
- Límite conocido (ya en `mail-idle.md`): una app password no es de solo lectura. La alternativa
  limitada es Gmail API OAuth `gmail.readonly`, que no está implementada.
- No verificado: ninguna conexión real a Gmail desde esta rama (sin credenciales).

## WhatsApp: no hay vía gratuita y legal verificada para este caso

- Vía no oficial (Baileys, whatsapp-web.js, etc.): automatiza una cuenta de usuario; incumple las
  condiciones de WhatsApp y puede acabar en baneo del número. Descartada.
- Vía oficial (WhatsApp Business Platform / Cloud API): necesita cuenta de empresa en Meta y un
  número dedicado. Precios: la página de Meta dice que los mensajes de servicio no se cobran
  (https://whatsappbusiness.com/products/platform-pricing/), pero varios proveedores y prensa
  describen que desde el 1 oct 2026 se cobran pasadas las primeras 1.000 al mes por número
  (https://docs.ycloud.com/en/documentation/whatsapp-business-platform/pricing-limits-and-quality/whatsapp-pricing,
  https://help.twilio.com/articles/53100480177819-Notice-Changes-to-WhatsApp-s-Pricing-October-2026).
  Un asistente personal quedaría dentro de 1.000/mes, pero las dos fuentes no coinciden: no verificado.
- Condiciones: los Business Solution Terms (modificados el 15 ene 2026,
  https://www.whatsapp.com/legal/business-solution-terms) excluyen chatbots de IA de propósito
  general (https://techcrunch.com/2025/10/18/whatssapp-changes-its-terms-to-bar-general-purpose-chatbots-from-its-platform/);
  Italia y Brasil quedaron exentos (https://9to5mac.com/2026/01/15/meta-reverses-whatsapp-third-party-chatbot-ban-in-italy-and-brazil/).
  Asistenta es un agente general, así que usar la API oficial para él es probablemente
  incompatible con esas condiciones. No he leído el texto legal completo: es una lectura, no un
  dictamen.
- Decisión: no se implementa nada. Reabrir solo si Nico acepta crear la cuenta de empresa y
  se confirma por escrito que el uso está permitido. Telegram (ya integrado) sigue siendo el canal.

# Ritmo de avisos y preguntar ante ambigüedad

- `/avisos [menos|minimo|normal]` (solo DM del dueño): ritmo de los avisos del filtro de
  correo/citas. `normal` = el límite revisado (4/24 h, 30 min entre avisos); `menos` = 2/24 h y
  2 h; `minimo` = 1/24 h y 8 h. Solo puede ser más estricto que el límite base; el código lo
  acota. No cambia los recordatorios de plazos/pagos del ojo de águila ni el silencio nocturno.
- Adaptativo: 3 avisos descartados con `/ignora` en 48 h bajan un nivel y se lo dice. Volver
  a subir lo decide solo él con `/avisos normal`. Solo cuenta descartes con su hora, no contenido.
- Herramienta `preguntar` + regla en el prompt: ante una acción con efecto (mensaje a otra
  persona, pago, reserva, borrado, sobrescritura, instalación) con 2 o más destinatarios, ítems,
  fechas o importes plausibles sin resolver, el modelo hace UNA pregunta con las opciones y para.
  No sustituye la puerta de aprobación (`permissions.ts`): la precede.
- No verificado: que el modelo gratuito use `preguntar` de forma fiable. Hay tests de la
  herramienta y del límite, no medida de comportamiento con el modelo real ni prueba en Telegram.
