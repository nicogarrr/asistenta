# PDF a texto: tablas comprobadas

Cuando Asistenta pasa un PDF o una foto a texto con el OCR local (`ocr_local`, ver
«OCR local (opcional)» en el README), revisa las tablas que salen en Markdown **sin IA**:

- Que todas las filas tengan las mismas columnas que la cabecera. Unas pocas filas
  distintas se toleran (suelen ser celdas combinadas); si son mayoría, la tabla no cuadra.
- Que en una columna de números el último valor sea la suma de los anteriores (con un 1 %
  de margen). Las series que solo suben o solo bajan (2030, 2040, 2050…) no se tratan como
  sumas, salvo que acaben en una fila «Total».
- Que la tabla no esté vacía (cabecera sin datos).

Si una tabla no cuadra, el texto llega entero y al final dice, por ejemplo:

> Ojo: no he podido comprobar una tabla; revísala con el PDF original:
> - página 2, tabla 1: en la columna «Euros» la suma (100) no da el total (108).

## Nada se pierde

Si una página de un PDF sale sin texto o tiene una tabla que no cuadra, Asistenta guarda
esa página como imagen junto al PDF, en la carpeta `<nombre>-paginas/` (`pagina-2.png`…,
como mucho 10 por documento), y la enlaza al final del texto. Así siempre tienes el
original a mano. Usa lo que ya trae Asistenta para leer PDFs; no instala nada más.

## Pedirlo con tus palabras

Manda el PDF y escribe en el pie, por ejemplo, «pásame este PDF a texto», «sácame el
texto» o «hazle OCR». Es lo mismo que el pie «/ocr md»: te devuelve el texto en Markdown
y te avisa si una tabla no cuadra. Solo en tu chat privado; si la frase es una pregunta
sobre el PDF («¿qué dice la página 3?», «resume este PDF»), contesta Asistenta como
siempre.

## Créditos

Las ideas (comprobar tablas sin IA, guardar el recorte de lo que no se pudo leer y
seguir por donde iba en PDFs largos) vienen de
[pdf2md](https://github.com/Ntizar/pdf2md) de Ntizar, con licencia MIT. Asistenta no
incluye pdf2md ni su Python: es una versión propia en TypeScript.
