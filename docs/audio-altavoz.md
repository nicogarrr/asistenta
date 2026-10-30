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
