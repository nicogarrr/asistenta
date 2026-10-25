# OCR de PDF y fotos por Telegram

Manda un PDF escaneado o una foto de un documento por Telegram y te lo devuelvo con el
texto **seleccionable y buscable**. Todo se hace en tu PC, sin servicios externos y sin
coste.

## Cómo se usa

En el chat privado, manda el archivo y escribe esto en el **pie** (el texto que acompaña al archivo):

| Pie | Qué recibes |
| --- | --- |
| `/ocr` | El PDF con texto buscable (`nombre_OCR.pdf`) |
| `/ocr md` | Un Markdown con el texto, página a página |
| `/ocr todo` | Los dos |

Admite PDF, JPG y PNG, hasta 20 MB (límite de Telegram para bots) y 40 páginas por envío.
El tipo se decide por el contenido del archivo, no por su nombre. Para otros formatos (HEIC,
Word, TIFF), conviértelos antes. Si estoy con otro documento te lo digo y no lo proceso:
tendrás que mandarlo de nuevo.

## Qué hace con cada página

- **Con texto propio** (PDF digital): se deja tal cual y su texto va al Markdown. Si todo el PDF ya tenía texto, te lo digo y no hace OCR.
- **Escaneada** (imagen): se lee con el OCR de Windows y el texto se añade como capa invisible **encima de la página original**. La imagen no se toca ni se recomprime.
- **No se puede leer** (girada, fallo del OCR, vacía): queda como estaba y el mensaje te dice cuáles y por qué.

## Límites (léelos)

- **El OCR se equivoca.** Cifras, nombres propios y tildes sobre todo. Si el dato importa (un importe, un DNI, una fecha), compruébalo en el original. No lo uses como única fuente.
- No entiende tablas ni columnas: el texto sale línea a línea y el orden de lectura no está garantizado.
- La capa de texto se coloca por líneas, así que al seleccionar una palabra puede resaltarse un tramo algo mayor.
- Páginas con rotación en el PDF: todavía no las proceso (quedan sin leer, y se avisa).
- Tope de 60 megapíxeles por foto y 8 minutos por envío; si se pasa, se para y se avisa.
- El **OCR y el render de páginas escaneadas solo funcionan en Windows** (usan Windows.Data.Pdf y Windows.Media.Ocr, que ya vienen con el sistema). En otros sistemas, los PDF que ya tienen texto sí funcionan; lo escaneado dice que no puede.
- El idioma lo elige el reconocedor de Windows (prefiere español). Si falta el paquete de idioma, el mensaje de error lo indica.

## Privacidad y originales

- Se procesa en una carpeta temporal propia que se borra siempre al terminar, también si falla o se corta por tiempo.
- No se indexa en la memoria, no se guarda y el contenido del documento no se escribe en los logs.
- Tu original no se modifica ni se borra: sigue en el chat de Telegram. El resultado es un archivo nuevo.
- Solo funciona en el chat privado del dueño y de uno en uno.

## Estado de la verificación

Probado en Linux con PDF reales generados (digital, escaneado, mixto, corrupto, girado, demasiado largo), imágenes-bomba y OCR simulado. Comprobado con poppler que la capa invisible queda alineada con el texto (menos de 3 pt de diferencia en una página de prueba), que el texto se extrae y que la página se ve píxel a píxel igual que el escaneo original.

**No verificado en Windows real**: el render de PDF con Windows.Data.Pdf y el OCR de Windows se tienen que probar allí con un escaneado de verdad antes de fiarse.

## Pendiente (otra entrega)

Carpeta compartida de entrada/salida (como la del post original), con originales archivados y errores aparte.
