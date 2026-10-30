# Rutinas de comando (sin modelo, coste 0)

Desactivadas por defecto. Actívalas con `PA_CRON_COMANDOS=1` y reinicia Asistenta.

Para programas tuyos que ya saben hacer el trabajo («ejecuta este script y mándame lo que imprima»):
el comando corre a su hora **sin pasar por el modelo** y su salida llega tal cual.

1. En el chat privado del dueño: `/cron comando <horario cron> [--timeout segundos] -- <programa> [argumentos]`
   Ej.: `/cron comando 0 8 * * * -- node C:\scripts\saldo.js`
2. Asistenta enseña el comando exacto, la carpeta y el horario, y un código:
   `/cron comando confirmar <nombre> <código>`. Hasta confirmarlo no se programa nada.
3. Para que solo avise cuando la salida cambie: `/cron entrega <nombre> chat solo-si-cambia` (ver F6).

Reglas de seguridad:
- Sin shell: `;`, `|`, `&&` o `$()` se pasan como texto al programa.
- La aprobación va ligada al hash de argv + carpeta + tope de tiempo, y la rutina solo corre con el horario aprobado.
  Si el fichero `command-routines.json` se edita a mano, no se ejecuta y se avisa.
- Tope de tiempo 60 s por defecto (máximo 120 s); se entregan como mucho 3.500 caracteres.
- Código de salida distinto de 0 o tiempo agotado: aviso con las últimas líneas (siempre se avisa).
- Con la función apagada, una rutina de comando avisa y no hace nada: nunca se manda al modelo.
- `/cron del <nombre>` borra la rutina y su aprobación. `/cron probar <nombre>` la ejecuta ahora.

`/cron` (la lista) marca cada rutina de comando con ⚙️: «sin aprobar (no se ejecuta)», «apagado (PA_CRON_COMANDOS=1 para activarlo)» o el comando exacto que va a correr.
