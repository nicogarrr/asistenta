# 📥 La bandeja de entrada

Nico (11-nov-2026): guarda cosas todo el día (vídeos de YouTube, posts de X, PDFs, artículos, libros) y nunca llega a verlas. La bandeja las filtra según llegan y por la noche le dice qué hacer con cada una: **no basta con un resumen**.

## Cómo se usa (Telegram)

- **Mándalo a secas**, sin escribir nada más: un enlace (o varios), un PDF, EPUB o Word (DOCX/ODT) sin pie, una captura sin pie, o un reenvío de otro chat con un enlace. Contesta «📥 guardado en la bandeja · 3 hoy» con **⚡ Míralo ya** (lo procesa ahora y te manda la ficha) y **🗑️ Quitar**.
- **«libro: Título»** (o «📚 Título») guarda un libro.
- **/bandeja <enlace o texto>** guarda a mano; **/bandeja libro <título>**; «/bandeja» como pie de una foto o un PDF.
- Con una pregunta o una frase tuya («resúmeme esto <enlace>», un PDF con «¿qué opinas?») te contesto como siempre: eso no va a la bandeja. Tampoco una respuesta a otro mensaje, ni notas de voz, ni grupos.

Órdenes: `/bandeja` (lo de hoy) · `/kindle N` o `/kindle <enlace>` (📖 al Kindle) · `/bandeja ver N` (ficha) · `/bandeja ahora N` · `/bandeja resumen` (el resumen ya, sin tocar el de la noche) · `/bandeja semana` · `/bandeja pendientes` · `/bandeja hora 22:00` · `/bandeja captura on|off`.

## Qué hace con cada cosa (en segundo plano, de una en una, sin reintentos)

1. **El contenido real**, por este orden:
   - YouTube: subtítulos; si no hay, baja solo el audio y lo transcribe el whisper local del PC (lo mismo que `resumen_video`, tope `PA_RESUMEN_MAX_MIN`).
   - X: el texto del post por la API pública de fxtwitter; si trae vídeo, su transcripción.
   - Spotify: título y programa de la ficha; la transcripción sale de la misma entrega en YouTube y, si no, del mp3 del RSS del programa (búsqueda pública de iTunes), transcrito en el PC.
   - Artículos: el texto de la página. PDFs: su texto (páginas reales). EPUB, DOCX y ODT: su texto entero (el lector de documentos de Asistenta). Capturas: el modelo las lee; **una captura con varias cosas guardadas** (un chat con tarjetas de YouTube/X) se parte en una por cosa, sin repetir lo que ya estaba (misma clave: id del vídeo o del post).
   - Libros: **Goodreads** (página pública de búsqueda: media y número de valoraciones; si bloquea o no está, «N/D» con el motivo, nunca una nota inventada) y **Open Library** (autor, año, páginas, descripción).
   - Solo si todo falla se juzga por la descripción o la ficha, y la ficha lo dice: «⚠️ Sin transcripción: juzgado por la descripción (motivo)».
2. **El coste**: minutos del vídeo/episodio, páginas del PDF o del libro, minutos de lectura (230 palabras/min).
3. **El veredicto** (el modelo normal de Asistenta, `pa-bandeja`): 🔴 *Imprescindible: míralo/léelo entero* · 🟡 *Ideas buenas: con el resumen basta* · ⚪ *Paja: descártalo*, con **nota 1–10**, el motivo y 3–5 ideas clave. Etiqueta con «Tus temas» si toca alguno (un ticker, una empresa).
4. **El enlace directo** siempre: el de la cosa, la ficha de Goodreads, la versión en YouTube de un podcast, y el **PDF original** si el autor o la página lo ofrecen (citation_pdf_url, arXiv, enlace .pdf), que se adjunta tal cual en lo 🔴. Nunca se rehace en PDF el texto de otro.

## El resumen de la noche

A las **21:30** (Europe/Madrid; `PA_BANDEJA_HORA` o `/bandeja hora`), un mensaje: cuántas cosas, 🔴 → 🟡 → ⚪, lo que te lleva lo imprescindible y la paja que te ahorras, con **✅ visto · ⏭️ mañana · 🗑️ fuera** por cosa (tres por fila) y **🧹 Quitar la paja**.

- Lo 🔴 que no marcas como visto **pasa al día siguiente** con «⏰ pendiente desde hace N días».
- Lo que no salió en ningún resumen (el PC apagado a esa hora) entra en el siguiente.
- Los **domingos**, detrás: «🏆 Tu semana en la bandeja» (lo mejor por nota, cuánto quedó por ver).
- `PA_BANDEJA_VOZ=1`: también como nota de voz (después del texto).

## 📖 Al Kindle

Para leer en el Kindle (Nico: «generar el PDF y si se puede con Calibre convertir a formato Kindle Paperwhite 11ª generación»).

- **Cómo se pide**: el botón **📖 Al Kindle** de la ficha (y «📖 N Kindle» en el resumen de la noche), contestar **«kindle»** al enlace que mandaste, al «📥 guardado» o a la ficha, o **/kindle N** / **/kindle <enlace>** (aunque no esté en la bandeja). Con **«pdf»** detrás (`/kindle 12 pdf`, «kindle pdf») sale además en PDF.
- **Qué cosas**: artículos y páginas, PDFs, EPUB y Word, posts e hilos de X, y la **transcripción real** de un vídeo o podcast (la que se guardó al procesarlo; si no la hay, se saca otra vez por el mismo camino). Un vídeo juzgado solo por su descripción no tiene botón: no hay texto que leer.
- **Qué sale**: el texto entero (Readability, el mismo extractor que `fetch`), con una primera página con título, autor, fecha, fuente y enlace, en un **EPUB** limpio. Con **Calibre** en el PC (`ebook-convert`: en el PATH, en `C:\Program Files\Calibre2` o en `PA_EBOOK_CONVERT`), también el **AZW3** del Paperwhite (`--output-profile kindle_pw3`) para pasarlo por USB a la carpeta `documents`. Sin Calibre se queda en EPUB y lo dice una vez: `winget install calibre.calibre` (no se instala solo). Un PDF o un EPUB que mandaste va **tal cual** (el EPUB, además, en AZW3 con Calibre); un DOCX/ODT sale en EPUB con su texto.
- **Correo a tu Kindle** (apagado hasta que lo pongas): `PA_KINDLE_EMAIL=tu_nombre@kindle.com` o `/bandeja kindle correo tu_nombre@kindle.com` (`… correo off` lo apaga). Va el EPUB (Amazon lo convierte) o el PDF, con el correo de Asistenta. Amazon **solo** acepta remitentes aprobados: Amazon → Contenido y dispositivos → Preferencias → Documentos personales → añade el correo de Asistenta.
- **Automático**: `/bandeja kindle auto on` (o `PA_KINDLE_AUTO=1`) manda solo lo 🔴 «léelo entero» en cuanto se juzga; los vídeos 🔴 no (son para verlos; el botón sí los manda).
- **Solo para ti**: va a tu chat y a tu Kindle, nunca a otro sitio. Con muro de pago, «inicia sesión» o una página que no deja leerla, no se salta: te paso el enlace y el porqué.
- `/bandeja kindle` dice cómo está todo.

## Ajustes

| Variable | Por defecto | Qué hace |
|---|---|---|
| `PA_BANDEJA_HORA` | 21:30 | hora del resumen (también `/bandeja hora`) |
| `PA_BANDEJA_CAPTURA` | 1 | 0 = no guardar lo que llega a secas (también `/bandeja captura off`) |
| `PA_BANDEJA_VOZ` | 0 | 1 = resumen también en voz |
| `PA_KINDLE_EMAIL` | (vacío) | tu dirección @kindle.com: «📖 Al Kindle» también por correo (o `/bandeja kindle correo`) |
| `PA_KINDLE_AUTO` | 0 | 1 = lo 🔴 para leer entero va solo al Kindle (o `/bandeja kindle auto on`) |

Datos: `<estado>/bandeja.db` (SQLite). Código: `src/bandeja/`.
