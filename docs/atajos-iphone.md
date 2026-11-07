# Atajos del iPhone: «Oye Siri, pregunta a Asistenta»

Asistenta tiene una puerta para la app **Atajos** de iOS: `POST /api/atajo`. El iPhone dicta y lee la respuesta en voz alta, así que el PC no tiene que oír ni hablar (lo lento de /voz en un portátil sin GPU). Sirve para Siri, para el **botón de acción** y para **Compartir → Mandar a Asistenta**. No hace falta app nativa ni cuenta de desarrollador.

## Qué necesitas

- El panel por Tailscale ya funcionando (ver [panel-remoto.md](panel-remoto.md)): `/tailscale` en Telegram debe decir que está listo.
- Tailscale conectado en el iPhone. En la app de Tailscale, activa la conexión bajo demanda para que esté siempre encendida.
- La dirección del panel (la de `/panel`, del estilo `https://tu-pc.tu-red.ts.net/`) y su token (`PA_WEB_TOKEN`).

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
