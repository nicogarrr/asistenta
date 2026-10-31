# Dictado por voz en cualquier app

Mantén una tecla, habla y suelta: el texto aparece donde tengas el cursor (WhatsApp Web, Word, el navegador, el correo…). Todo pasa en tu PC con la misma voz local que las notas de voz: gratis, sin límite y sin claves.

## Encenderlo

1. En el `.env` pon `PA_DICTADO=1` y reinicia Asistenta.
2. Comprueba el micrófono: `pa dictado prueba` (graba 5 segundos y te enseña el texto, sin escribirlo en ningún sitio).
3. Comprueba la tecla: `pa dictado tecla`.

La tecla por defecto es **Ctrl + Windows**. Para cambiarla: `PA_DICTADO_TECLA=ctrl+alt` (también vale `f9`, `ctrl+shift`…). Una letra sola o Ctrl solo no valen.

## Usarlo

- Mantén la tecla: suena un pitido agudo y empieza a grabar.
- Habla con normalidad.
- Suelta: suena un pitido más grave y en uno o dos segundos aparece el texto.
- Dos pitidos graves: no se ha podido (sin micrófono, o estás en un campo de contraseña).
- Como mucho graba 2 minutos seguidos; al llegar ahí escribe lo dicho.
- **Esc** mientras graba tira lo grabado: no escribe nada.
- Si prefieres no mantener la tecla: `PA_DICTADO_MODO=alternar` (una pulsación empieza, otra termina).

Puedes dictar signos: «coma», «punto», «punto y coma», «dos puntos», «punto y aparte», «nueva línea», «abre interrogación» / «cierra interrogación», «abre exclamación», «abre paréntesis» / «cierra paréntesis». Las muletillas («eh», «em», «o sea») se quitan solas. «Que se coma la tarta» o «el punto de encuentro» se quedan como palabras.

## Privacidad

- Apagado por defecto. Solo funciona en tu PC, con tu teclado: nadie lo activa desde Telegram ni desde fuera.
- No guarda audio ni texto. En el registro solo queda cuántas letras se escribieron.
- Nunca escribe en un campo de contraseña: lo mira al pulsar y otra vez antes de escribir.

Si usas la palabra de activación a la vez, los dos comparten el micrófono sin problema.

Esc para descartar y el modo alternar son ideas de [pi-voice](https://github.com/earendil-works/pi-voice) (MIT).
