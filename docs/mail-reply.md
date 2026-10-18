# Correo bajo petición con revisión (fase 4)

Depende de fases 1-3. `/correo lista` muestra hasta 8 correos recientes de INBOX en tarjetas
individuales con UIDVALIDITY:UID. Responder a UNA tarjeta del bot con `responde a ese`
y salto de línea + texto exacto selecciona esa referencia, nunca adivina por "último correo".
También admite `/correo responder UIDVALIDITY:UID` + salto de línea + texto exacto.
Solo owner autenticado en su DM; no herramientas de modelo ni activación por email externo.
Las tarjetas caducan al reiniciar o salir del límite de 100; se vuelve a pedir lista.

No redacta respuestas por su cuenta: el cuerpo viene de la petición del dueño. Antes de
SMTP muestra cuenta, destinatario, asunto, texto, ausencia de CC/BCC, Reply-To observado
(que no se usa) y Authentication-Results (sin verificar, solo informativo). Requiere
aprobación cada vez. Nunca aplica permiso persistente de autoenvío ni excepción inferida.

`mailSend:address/password` separado, sin fallback a mailRead o mail general. Cuenta debe
coincidir con mailRead. No provisiona/copia secretos automáticamente. No borra ni marca leído.
Lecturas EXAMINE + BODY.PEEK, referencia vinculada al epoch UIDVALIDITY. Metadata incluye
Message-ID RFC y References validados; SMTP usa In-Reply-To/References reales, no UID IMAP.
Rechaza origen sin ID RFC válido o sin identidad de hilo Gmail. Destinatario único From,
sin Reply-All ni seguir Reply-To. La identidad del remitente NO queda autenticada por eso.

Lee Todo el correo por special-use All Mail para incluir respuestas enviadas del dueño.
Snapshot acotado de hasta 30 mensajes del threadId Gmail, vuelve a buscar al acabar para
detectar llegada durante lectura. Tras aprobar relee hilo completo y compara digest; cualquier
cambio exige otra revisión. No puede impedir una llegada en el breve intervalo final entre
comprobación y SMTP. No reclama entrega: solo aceptación SMTP. No reintenta fallos ambiguos.

Fallos cerrados: All Mail inexistente/ambiguo, hilo >30, sin threadId, UIDVALIDITY cambiado,
Message-ID duplicado/inválido o hilo cambiado. Contenido de correo aún usa parser anterior,
no decodificador MIME completo, por lo que algunos HTML/base64 pueden no ser legibles.
DKIM/DMARC del header se muestran como afirmaciones del mensaje, NO verificación criptográfica.
No usar estos datos como aprobación del usuario ni como garantía de autoría.

Pruebas simuladas de lista, lecturas EXAMINE, All Mail, IDs RFC, referencias, cambio de hilo,
rechazo de revisión, cuenta equivocada e inyección de destinatarios. Falta prueba con Gmail,
lista y aprobación Telegram reales y SMTP autorizado por Nico. CI Node 24 antes de merge.
No anunciar como instalado en el PC ni plenamente verificado en uso real.
