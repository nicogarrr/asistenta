# Correo desde el chat

Asistenta puede **leer** tu Gmail y **enviar** correos desde Telegram con la herramienta `correo`.

## Qué puede hacer

- «¿Tengo correos de Ana?», «léeme el último del banco», «resume lo que me ha llegado hoy»:
  `buscar` (de, asunto, texto, no leídos, días) y `leer` (con la ref que da `buscar`; dice los
  adjuntos por nombre y tamaño, sin descargarlos).
- «Contéstale que sí», «reenvíaselo a Luis», «escribe a b@c.es diciendo…»: `responder` (en el
  mismo hilo), `reenviar` (con el original debajo) y `nuevo`.
- Archivar, marcar como leído y limpiar: lo hace la herramienta `correo_reglas` (otra parte).

## La regla de seguridad

**Ningún correo sale sin tu sí a ese borrador exacto.** Cada envío te enseña Para, CC, Asunto y el
cuerpo entero, y solo se envía si lo apruebas. No vale un «Siempre», ni el control total, ni una
aprobación anterior del mismo texto: se pregunta cada vez. Si el borrador no cabe entero en la
pregunta, se deniega. Asistenta no envía nada que no le hayas pedido, y solo a direcciones que
nombraste o que están en el hilo.

El correo es privado y lo escriben otros: solo se lee en tu chat privado, y después de leerlo
Asistenta pregunta antes de mandar datos a webs nuevas.

## Configurarlo en tu PC (Windows)

1. En tu cuenta de Google activa la verificación en dos pasos.
2. Crea una contraseña de aplicación en https://myaccount.google.com/apppasswords (16 letras).
3. Lectura:
   - `pa vault set mailRead:address tu@gmail.com`
   - `pa vault set-stdin mailRead:password` y pega las 16 letras.
4. Envío (puede ser la misma cuenta y la misma contraseña):
   - `pa vault set mailSend:address tu@gmail.com`
   - `pa vault set-stdin mailSend:password` y pega las 16 letras.
5. Reinicia Asistenta. `/correo estado` te dice si lectura y envío están bien.

Si falta algo, Asistenta te lo dice con estos mismos pasos («Falta configurar el envío: …»).
