# Tele LG: órdenes, estado, encendido por red y modo cine

Todo pasa por la herramienta `tv` (lo usa el agente; tú se lo pides en Telegram con tus palabras).

## Órdenes naturales (`action=command`)
Deterministas, sin modelo. Ejemplos:

| Dices | Hace |
|---|---|
| «apaga la tele» / «enciende la tele» / «apágala» / «enciéndela» / «apaga el televisor» | `power` (ver encendido por red) |
| «volumen a 20» | volumen absoluto (necesita Glasshouse) |
| «sube el volumen», «baja 5», «más alto» | pulsaciones del mando (`volumeStep`, sin Glasshouse) |
| «silencio» / «apaga el sonido» / «quítale el sonido» / «quita el silencio» | `mute` |
| «canal 5», «pon la 1», «siguiente canal» | `channel` (dígitos + ENTER, CHANNELUP/DOWN) |
| «abre Netflix», «pon YouTube», «quiero ver DAZN» | `launch` por nombre |
| «pausa», «pon pausa», «dale al play» | `media` |
| «dale a pausa», «pulsa pausa», «detén (la peli)»; «pulsa play»; «stop», «pulsa stop» | `media` pausa / play / stop |
| «súbele más», «baja más (el volumen)» | paso de volumen (3) |
| «sube mucho», «bájale bastante», «sube un montón», «mucho más alto», «bastante menos volumen» | paso grande de volumen (10) |
| «pon el 5», «ponme el 24» | canal (como «pon la 5») |
| «adelanta», «avance rápido», «rebobina (el vídeo)», «retrocede» | `media` avance/retroceso (una pulsación; con segundos va al modelo) |
| «súbela» / «bájala (un poco)», «más volumen» / «menos volumen», «volumen arriba/abajo» | un paso de volumen |
| «sube a 30», «baja a 10», «pon la tele a 15», «ponla a 20» | volumen a ese número |
| «súbele un par (de puntos)», «baja dos puntitos»; «cambia al 7», «cámbiala al 24»; «apaga ya la tele» | paso de volumen (2 / N); canal; apagar |
| «pon el HDMI 2» | `input` |
| «¿qué está viendo?», «¿está encendida?» | `status` |
| «modo cine», «modo cine con Netflix» | rutina `scene=cine` |

Si no entiende la orden, no toca la tele y lo dice con ejemplos.

## Abrir apps por nombre
`launch` acepta el id (`youtube.leanback.v4`) o el nombre («YouTube», «Disney+», «Prime Video»). Los nombres conocidos se resuelven sin preguntar a la tele; el resto se busca en las apps instaladas por título.

## Estado en vivo (`action=status`)
Sin captura y sin cambiar nada: encendida / pantalla apagada / en reposo / no responde, qué app o entrada (HDMI) tiene delante, volumen y silencio. Si la tele no conecta dice «apagada o fuera de red» (SSAP no distingue entre las dos).

## Encendido por red (Wake-on-LAN)
Con la tele apagada del todo no hay nada escuchando: «enciende la tele» manda un paquete Wake-on-LAN y espera hasta 20 s a que responda, y solo dice «encendida» si responde.

- La MAC se guarda sola al emparejar (`pa tv setup <ip>`) si la tele da una válida (una MAC multicast, todo ceros o broadcast se ignora); si no: `pa tv mac auto` con la tele encendida la lee de la red, o a mano `pa tv mac AA:BB:CC:DD:EE:FF` (Ajustes > General > Acerca de esta TV). `pa tv mac` rechaza las MAC imposibles (p. ej. el ID de una app de IPTV).
- En la tele: activar «Encender con Wi-Fi» / «Mobile TV On» (Ajustes > General > Dispositivos).
- `pa tv wake` envía el paquete a mano.

## Modo cine (`action=scene scene=cine`)
Encender si hace falta → quitar silencio → volumen 20 (o `level`) → abrir la app pedida (`appId`) → aviso en pantalla. Cada paso informa de su resultado; sin Glasshouse, volumen y silencio se omiten; si no se puede encender, la rutina para.

## Conexión y errores
- Si la tele rechaza la conexión al momento (recién despertada), se reintenta una vez; antes de conectar no se ha enviado nada, así que no se duplica ninguna orden. Un rechazo tras conectar nunca se repite.
- Los errores explican qué significan en castellano («No llego a la tele…», «Hay que volver a emparejar: pa tv setup <ip>», «La orden salió pero la tele no contestó… no la repito») y conservan el detalle técnico.
- Las teclas (tvKey) esperan 5 s como máximo a que abra el socket de botones y dan 800 ms de margen tras enviar. Si tu tele es lenta: `PA_TV_KEY_TIMEOUT_MS` (1000–30000) y `PA_TV_KEY_GRACE_MS` (50–5000).

## Más rutinas
- «modo noche» / «modo nocturno (con YouTube)»: volumen a 8 (o el que digas) y aviso. No enciende una tele apagada.
- «apaga todo»: aviso «Apagando. Buenas noches.» y apaga la tele; si ya está apagada no hace nada.

## Desde Telegram sin gastar
- Preguntas y quejas no son órdenes: «¿cómo se apaga la tele?», «¿por qué se apaga?», «la tele no se enciende» no tocan la tele (las contesta el modelo). Tampoco «la luz, apágala»: delante de «apágala» / «enciéndela» solo vale una muletilla («venga», «no», «puedes»…).
- Órdenes combinadas con un modo («modo cine y sube») o con otro aparato («apaga la tele y la luz») también van al modelo: la tele sola sería la mitad.
- También valen «apágala ya», «enciéndela ahora mismo», «vuelve a poner el sonido» (quita el silencio) y «¿qué hay en la tele?» / «¿qué estoy viendo?» (estado, solo lee).
- `/tv <orden>` (solo tú, en tu chat privado): «/tv apaga la tele», «/tv abre Netflix», «/tv volumen a 15», «/tv modo cine», «/tv estado». Va directo a la tele, sin pasar por el modelo (0 tokens). Si no la entiende, lo dice y no hace nada.
- Frases: «pon la uno» (canal en palabras), «sube a tope» / «volumen al máximo» / «súbela al máximo» / «pon la tele a tope» = volumen 100 (el máximo de la tele; decisión de Nico, 30-oct-2026; para menos, dilo con número: «volumen a 30»; «bájala a tope» / «baja el volumen al máximo» = volumen 1, nunca silencio), «quita el sonido» = silencio.
- `pa tv orden "<texto>"` en la terminal del PC: la misma orden, igual de directa y sin modelo («pa tv orden "volumen a 15"»). Código 0 si se hizo, 2 si no se entiende (no toca la tele), 1 si la tele falla.

## Mando con botones

`/tv` sin orden (solo el dueño, en su chat privado) saca un mando: 🔌 Encender, ⏻ Apagar, 🔉 Vol −, 🔊 Vol +, 🔇 Silencio, 🎬 Netflix, ⏸ Pausa, ▶️ Play e ℹ️ Estado (Pausa/Play necesitan Glasshouse; Estado solo lee). Cada botón es una orden fija que va por el mismo camino que `/tv <orden>` (sin modelo, misma cola de la tele). Pulsado por otro usuario o desde un grupo, no hace nada. La respuesta sale en el aviso del botón; si es larga (Estado) llega entera como mensaje.

Si la orden tarda más de 2,5 s (encender por WoL, tele lenta), el botón contesta al momento «Enviando a la tele…» y el resultado llega después como mensaje en el mismo chat: Telegram solo deja contestar al botón durante unos segundos.

`/tv baja a la mitad` (o «volumen a la mitad») lee el volumen real y lo deja en la mitad; nunca lo sube y, si no puede leerlo, no toca nada.

Doble toque: si se pulsa el mismo botón del mando dos veces en menos de 1 s (o Telegram entrega dos veces el mismo toque), la orden se manda una sola vez y el aviso dice «Ya lo he mandado; espera un segundo para repetir». Vol + y Vol − no se filtran: dos toques seguidos suben o bajan dos pasos.

## Extras de Glasshouse en las rutinas (decidido 30-oct-2026)

Nico pidió «elige las opciones con más lógica»:
- «apagar todo» cierra antes la app que esté abierta (la de primer plano; la pantalla de inicio no) y luego apaga.
- «modo noche» baja el volumen y pone la imagen oscura (modo de imagen «eco», el más oscuro de LG).
- Los dos extras son opcionales: sin Glasshouse se omiten y, si la tele los rechaza, se ignoran (apagar todo apaga igual).
- Volver a la imagen de antes: «pon la imagen en estándar» (la tool `tv` con `action=picture pictureMode=standard`, o cine, vivid…) o desde el menú de la tele. El modo cine no toca la imagen.
- Ninguna rutina programa el temporizador de apagado.

### Mando: atrás, imagen y límites

- «vuelve atrás», «atrás», «pulsa el botón de atrás»: tecla ATRÁS del mando (BACK).
- «ve a inicio», «vuelve al inicio», «pulsa el botón de inicio», «pantalla de inicio», «home»: tecla INICIO del mando (HOME).
- «ok», «pulsa ok», «aceptar»: tecla OK (ENTER). «arriba», «pulsa abajo», «flecha izquierda», «muévete a la derecha»: flechas del mando. «salir», «sal de la app», «cierra la app»: tecla SALIR (EXIT).
- Canales: «cambia a la 2», «pon la tele en la 1», «ponla en la 5», «cámbiala a la tres»; «cambia de canal» = canal siguiente.
- Modo de imagen por voz: «pon la imagen en estándar» (o «normal»), «imagen oscura» / «modo ahorro» (eco), «imagen en modo cine», «imagen viva», «modo estándar», «modo vivo», «modo eco» («modo normal» a secas es ambiguo y lo decide el modelo), «modo de imagen juego», «imagen de deportes». Un modo que no conozco no se adivina. «modo cine» sin «imagen» sigue siendo la rutina de cine y no toca la imagen.
- «sube 20» sube como mucho 15 de una vez (seguridad) y ahora lo dice: «Pediste subir 20, pero de una vez subo como mucho 15: lo he subido 15.». Para un valor exacto: «volumen a 40».
