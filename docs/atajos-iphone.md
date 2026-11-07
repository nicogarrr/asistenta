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

## Atajo 3: automatizaciones (van solas)

Atajos → **Automatización** → «+». Desde iOS 17 se pueden ejecutar sin preguntar (**Ejecutar inmediatamente**).

**Al llegar a casa / al salir de casa** (sin compartir la ubicación en Telegram):

1. Disparador **Llegar** (o **Salir**) → Ubicación: tu casa → **Ejecutar inmediatamente**.
2. **Obtener contenido de URL**: `https://tu-pc.tu-red.ts.net/api/atajo/lugar`, método **POST**, el mismo encabezado `Authorization`, cuerpo **JSON** con `evento` = `llegar` (o `salir`) y `sitio` = `casa` (o el nombre de un sitio guardado, «el gimnasio»).
3. **Si** *Contenido de la URL* **tiene algún valor** → **Mostrar notificación** (o **Leer texto**) con *Contenido de la URL*.

Saltan los avisos de «cuando llegue a casa recuérdame…» (y de salir), también en Telegram. Si no hay ninguno, la respuesta va vacía y no se enseña nada. «casa» es el sitio guardado como casa o, si no, `PA_BRIEFING_LAT/LON`.

**Resumen de la mañana a las 8:00**:

1. Disparador **Hora del día** → 8:00, Diariamente → **Ejecutar inmediatamente**.
2. **Obtener contenido de URL**: `…/api/atajo/resumen`, método **POST**, mismo encabezado (sin cuerpo).
3. **Leer texto** con *Contenido de la URL*.

Es el mismo resumen que `/resumen hoy`, sin emojis ni Markdown para leerlo en voz alta. No cambia el ritmo del resumen de Telegram.

## Atajo 4: Salud y Calendario a la memoria

`POST /api/atajo/datos`. Solo se guarda lo que el atajo manda y solo estos campos; cualquier otro se ignora y la respuesta lo dice.

- `{"tipo": "salud", "pasos": 8432, "sueno_horas": 7.5, "ejercicio_min": 35, "fecha": "2026-11-07"}` → una línea en `notas/salud.md`: «Salud (iPhone) 2026-11-07: 8432 pasos; durmió 7 h 30 min; 35 min de ejercicio».
- `{"tipo": "calendario", "eventos": "10:00 · Dentista\n18:00 · Pádel"}` → una línea en `notas/agenda.md` (máx. 15 eventos).
- Una línea por día y tipo: si lo mandas otra vez el mismo día, se corrige en su sitio.
- `fecha` es opcional (por defecto, hoy en el PC). Los números aceptan «8.432» y «7,5».

Receta de Salud: **Buscar muestras de salud** (Tipo es Pasos, Fecha de inicio es hoy) → **Calcular estadísticas** (Suma) → **Obtener contenido de URL** con `tipo` = `salud` y `pasos` = *Estadísticas* → **Mostrar notificación**.
Receta de Calendario: **Buscar eventos del calendario** (Fecha de inicio es hoy) → **Repetir con cada**: **Texto** «*Hora de inicio* · *Título*» → **Combinar texto** (Nueva línea) → **Obtener contenido de URL** con `tipo` = `calendario` y `eventos` = *Texto combinado*.

## 5: pagar con Apple Pay desde el iPhone

Asistenta prepara el carrito o el enlace de pago y lo manda por Telegram con un botón «Pagar con Apple Pay en Safari». El pago lo haces tú con Face ID; Asistenta nunca paga.

## Atajo 6: con el PC apagado

Atajos no tiene «si falla, haz otra cosa»: si el PC está apagado, «Pregunta a Asistenta» se para con un error de conexión. Para eso, un segundo atajo **Asistenta sin PC** (necesita Apple Intelligence):

1. **Dictar texto**.
2. **Usar modelo** → **En el dispositivo**, con «Contesta en 1 a 3 frases, en castellano:» y *Texto dictado*.
3. **Leer texto**: «Modo sin conexión, sin tu memoria ni herramientas.» y luego *Respuesta*.

«Oye Siri, Asistenta sin PC».

`/atajos` en Telegram manda todas estas recetas con tu dirección real y el token.
