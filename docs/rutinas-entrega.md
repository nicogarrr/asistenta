# Entrega de rutinas programadas

Cada rutina programada entrega por defecto su resultado en el chat donde se creó. Con
`/cron entrega` puedes cambiarlo sin reiniciar:

- `/cron entrega <nombre>`: dice a dónde entrega ahora.
- `/cron entrega <nombre> chat|fichero|ninguno`: `fichero` añade cada resultado a
  `<estado>/salidas/<rutina>/<AAAA-MM-DD>.md` sin mandarte mensaje; `ninguno` solo deja
  constancia en el log (para rutinas que actúan solas).
- `/cron entrega <nombre> solo-si-cambia` (o `siempre`): no te avisa si el resultado es igual
  (salvo espacios) al último entregado. Útil para vigilar algo que casi nunca cambia.

Si la rutina falla o no devuelve nada, el aviso llega siempre al chat. Los ajustes se guardan en
`<estado>/routine-delivery.json`; el nombre de la carpeta de salida se sanea (sin `..` ni
separadores). Los recordatorios no cambian: siempre llegan al chat.
