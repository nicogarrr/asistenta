# Entrada secreta por pipe

`pa vault set-stdin <clave>` recibe el valor solo por stdin no-TTY. No acepta un valor en argumentos. La terminal con eco se rechaza antes de leer nada; prepara un pipe privado desde un gestor de secretos u otra fuente que controles. No escribas el secreto en una línea de shell tipo echo/printf: eso lo vuelve a poner en el historial. El pipe no protege frente a un administrador local, procesos hostiles de tu usuario ni terminal grabada en su origen.

Ejemplo de forma, NO un secreto literal:

```sh
<comando-privado-de-tu-gestor> | node dist/cli.js vault set-stdin provider:apiKey
```

El comando no ejecuta ese marcador: sustituye el origen por el gestor que ya utilizas. No se introduce un gestor ni se conecta una cuenta automáticamente.

Límite 16 KiB y 30 segundos hasta EOF; una sola línea UTF-8, sin bytes nulos, no vacía. Solo se retira un salto de línea final opcional (LF o CRLF); no se recortan espacios del secreto. Errores de stream o del almacén se convierten en mensajes fijos sin contenido secreto. Valores no viajan por argv, env ni stdout desde este comando. No se afirma borrado perfecto de memoria: JavaScript mantiene cadenas que no se pueden limpiar con garantía; se ponen a cero los buffers temporales.

Se mantiene la elección existente de vault: DPAPI en Windows, portable en otros sistemas. No se cambia a portable para eludir DPAPI. No inicializa ni sobreescribe el vault cifrado por sí solo: usa vaultSet y su política actual. El modo portable conserva los permisos600 del archivo. No ejecuta modelos, Telegram, daemon, compras ni red. Esto es un prerrequisito del onboarding seguro, NO el wizard pa setup completo.

QA: pruebas dirigidas de lectura, LF/CRLF, vacío/multilínea/nulos/tamaño, clave/args inválidos antes de leer, TTY sin consumir, errores de stream/almacén sin secreto, timeout, UTF-8 corrupto. Dos procesos CLI compilados con secreto sintético y archivo portable temporal comprueban persistencia/permisos y ninguna impresión del valor. No se declara prueba nativa DPAPI Windows. Suite completa fresca pendiente al publicar.
