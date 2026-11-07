# Atajos del iPhone: «Oye Siri, pregunta a Asistenta»

Asistenta tiene una puerta para la app **Atajos** de iOS: `POST /api/atajo`. El iPhone dicta y lee la respuesta en voz alta, así que el PC no tiene que oír ni hablar (lo lento de /voz en un portátil sin GPU). Sirve para Siri, para el **botón de acción** y para **Compartir → Mandar a Asistenta**. No hace falta app nativa ni cuenta de desarrollador.

## Qué necesitas

- El panel por Tailscale ya funcionando (ver [panel-remoto.md](panel-remoto.md)): `/tailscale` en Telegram debe decir que está listo.
- Tailscale conectado en el iPhone. En la app de Tailscale, activa la conexión bajo demanda para que esté siempre encendida.
- La dirección y el token: escribe **/atajos** en Telegram. Te manda los pasos con tu dirección real y, aparte, el token listo para pegar (`Bearer …`). Ese mensaje se borra solo a los 10 minutos.

## Atajo 1: «Pregunta a Asistenta» (Siri y botón de acción)

En la app Atajos, crea un atajo nuevo llamado **Pregunta a Asistenta** con 3 acciones:

1. **Dictar texto** (Dictate Text). Idioma: español.
2. **Obtener contenido de URL** (Get Contents of URL):
   - URL: `https://tu-pc.tu-red.ts.net/api/atajo`
   - Método: **POST**
   - Encabezados: `Authorization` = `Bearer TU_TOKEN`
   - Cuerpo de la solicitud: **JSON**, con `text` = *Texto dictado* y `modo` = `voz`
3. **Leer texto** (Speak Text), con *Contenido de la URL*.

- Siri: «Oye Siri, pregunta a Asistenta» y le dices lo que quieras.
- Botón de acción: Ajustes → Botón de acción → Atajo → *Pregunta a Asistenta*.

## Atajo 2: «Mandar a Asistenta» (Compartir)

1. Crea un atajo **Mandar a Asistenta** y, en sus detalles, activa **Mostrar en la hoja de compartir** (Show in Share Sheet), con entrada de URL y texto.
2. **Obtener contenido de URL**, igual que arriba, pero con `text` = *Entrada del atajo* y `modo` = `texto`. Si quieres, pon delante «Vigila el precio de esto: » o lo que suelas pedir.
3. **Mostrar resultado** (Show Result) o **Mostrar notificación** con *Contenido de la URL*.

Desde Safari o Amazon: Compartir → *Mandar a Asistenta*.

## Cómo contesta

- Siempre con texto plano, sin Markdown, listo para leer en voz alta.
- `modo: voz` (el de por defecto) pide 1 a 3 frases cortas. `modo: texto` da una respuesta breve para leer en pantalla.
- Va al mismo hilo que Telegram, con la misma memoria y las mismas aprobaciones.
- Atajos corta la espera hacia los 60 s. Si Asistenta tarda más de 50 s, el atajo dice «Te mando la respuesta por Telegram en cuanto la tenga», y la respuesta llega allí.
- Si algo falla (token, PC, red), contesta con una frase en castellano, no con un error mudo.

## Órdenes desde Asistenta: que haga cosas en tu iPhone

El PC no puede lanzar un atajo en el iPhone por su cuenta, pero sí mandarle un correo. Desde iOS 17 una automatización «Al recibir un correo» se ejecuta sola. Así Asistenta puede pedirle al iPhone que **abra una app**, **mande un WhatsApp o un iMessage**, **cree un recordatorio o un evento** o **ponga música**. Antes de cada orden te pide permiso en Telegram.

Cómo funciona:

1. Asistenta manda un correo desde su cuenta (la de `/correo`) a `PA_IPHONE_CORREO`, o a esa misma cuenta si no lo pones. El asunto es `ASIS-<clave> <acción> #<n>` y el cuerpo es una línea JSON, por ejemplo `{"id":7,"accion":"whatsapp","para":"Mamá","texto":"Llego en 10"}`.
2. En el iPhone, la automatización (remitente = ese correo, asunto contiene `ASIS-<clave>`) ejecuta el atajo **Orden de Asistenta**.
3. El atajo hace la acción y confirma en `POST /api/atajo/resultado` con `{"id": 7, "ok": true}`. Asistenta te lo dice en Telegram («✅ Hecho en el iPhone…»). Si en 5 minutos no ha confirmado, también te avisa.

**/atajos** te da la clave, el remitente y la URL exactos. La clave es aleatoria, así que un correo de otro no dispara nada.

Acciones y campos del JSON:

| accion | campos |
|---|---|
| `abrir_app` | `app` |
| `whatsapp` | `para`, `texto` |
| `imessage` | `para`, `texto` |
| `recordatorio` | `texto`, `cuando` (opcional) |
| `evento` | `titulo`, `cuando`, `fin` (opcional) |
| `musica` | `busqueda` |

Atajo **Orden de Asistenta**: *Obtener diccionario de* la entrada del atajo, luego *Obtener valor* de `accion` y un *Si* por cada acción, usando las acciones normales de Atajos (Abrir app, Enviar mensaje de WhatsApp, Enviar mensaje, Añadir recordatorio, Añadir evento, Buscar en Apple Music y Reproducir). Al final, *Obtener contenido de URL* a `/api/atajo/resultado` con el mismo encabezado `Authorization`.

Sin comprobar en un iPhone real: si la automatización de correo pasa el cuerpo del correo como entrada (si pasa el correo entero, añade *Obtener texto de* la entrada), si WhatsApp manda el mensaje sin pedir confirmación, y cuánto tarda Mail en recibir el correo (con Gmail en la app Mail puede ir por intervalos, no al momento).
