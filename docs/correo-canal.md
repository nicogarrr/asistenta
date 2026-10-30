# Correo como canal (F10)

Apagado por defecto. Te permite escribir a Asistenta por correo y que conteste en el mismo hilo. Solo el dueño.

```
PA_CORREO_CANAL=1
PA_CORREO_CANAL_REMITENTES=tu@gmail.com          # lista de remitentes permitidos
# PA_CORREO_CANAL_AUTHSERV=mx.google.com          # servidor cuya cabecera Authentication-Results se cree
```

Un correo entra como turno solo si:
1. el asunto lleva `[asistenta]`;
2. el `From` es una sola dirección y está en la lista;
3. la cabecera `Authentication-Results` que puso tu servidor (la primera de `PA_CORREO_CANAL_AUTHSERV`) dice `dkim=pass` con `header.d` del dominio del remitente. Las cabeceras que trae el correo desde fuera no cuentan.
4. pesa menos de 5 MB.

Lo demás se ignora y queda en la auditoría con el motivo. Se quita la cita del correo anterior. La respuesta va con `In-Reply-To`/`References`.
Las aprobaciones nunca van por correo: llegan por Telegram y el correo solo lo avisa. Un turno de correo cuenta como contenido externo para la puerta de permisos (fuente «correo»).

Requiere las cuentas de lectura (`mailRead:*`) y envío (`mailSend:*`) del vault. El daemon revisa el buzón cada minuto, en solo lectura, y solo lo llegado después de activarlo (cursor en `<estado>/correo-canal.json`). Sin lista o sin cuentas no arranca y lo dice en el log.
