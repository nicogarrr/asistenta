# Audio de Telegram por los altavoces del PC o la tele

## Reproducir una nota de voz
Manda una nota de voz (o un audio) al bot y pide:

- «reprodúcelo en el ordenador», «suéltalo», «ponlo a 40» → suena en los altavoces del PC
  (la acción `media play`; también `/play` como pie del audio o justo después).
- «reprodúcelo en la tele» → suena en la LG (`media play target=tele`).

El PC sube el volumen del sistema al pedido (100 por defecto) y lo restaura al acabar.

## En la tele (apagado por defecto)
Actívalo con `PA_AUDIO_TELE=1` en `.env`. Requisitos: tele emparejada (`pa tv setup <ip>`),
PC y tele en la misma subred, y el firewall de Windows permitiendo conexiones entrantes de
la red privada a Node (Windows lo pregunta la primera vez).

Cómo funciona: el audio se convierte a MP3, se sirve desde un servidor efímero que solo
escucha en la IP del PC de esa subred, solo responde a la IP de la tele, usa una ruta
aleatoria y se cierra (borrando la copia) a los 10 minutos. Se pide a la tele que lo abra
con su visor multimedia (`media.viewer/open`); si su webOS no lo tiene, con el navegador
(`system.launcher/open`). Siempre pide aprobación.

No probado todavía en la tele real: si ninguna de las dos APIs funciona, el bot lo dice.

## Modo altavoz: `/altavoz`
- `/altavoz pc` — cada nota de voz que me mandes suena sola en el PC al llegar (sin cambiar el
  volumen del sistema). Siguen procesándose como siempre (transcripción y respuesta).
- `/altavoz tele` — igual, pero en la tele (necesita `PA_AUDIO_TELE=1`).
- `/altavoz off` — apagado (por defecto). `/altavoz` sin nada te dice el estado.

Solo funciona desde tu chat privado con el bot (el dueño verificado) y con el control del PC
activo. Las notas suenan en orden, una detrás de otra; si se acumulan más de 5, las nuevas no se
sueltan y te aviso. Un audio con un comando como pie (por ejemplo `/play`) no se duplica.

## ¿Y «llamar al bot»?
Telegram no deja que los bots reciban llamadas. `/altavoz` es lo más cercano: grabas, sueltas y
suena en 1–3 segundos. Las alternativas (chat de voz con una cuenta de usuario, o «hablar» en
directo desde el panel web) se estudian aparte.

## Probar la tele real: `pa audio prueba-tele`

`pa audio prueba-tele <fichero.mp3> [--via media.viewer|launcher|glasshouse]` manda el audio por la misma ruta que «reprodúcelo en la tele» y dice qué vía aceptó la tele (✗ por cada una que falló) y si llegó a descargar el fichero en 15 s. Código 0: la tele lo descargó; 1: no; 2: uso incorrecto.

Orden de vías: `media.viewer/open`, luego `system.launcher/open` y, solo si `tv:glasshouseUrl` está en el vault, Glasshouse (`url`).

Si la tele acepta pero nunca descarga el audio, casi siempre es el firewall de Windows: permite Node.js en redes privadas y comprueba que la Wi-Fi del PC está marcada como «privada».
