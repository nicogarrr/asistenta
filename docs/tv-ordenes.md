# Tele LG: órdenes, estado, encendido por red y modo cine

Todo pasa por la herramienta `tv` (lo usa el agente; tú se lo pides en Telegram con tus palabras).

## Órdenes naturales (`action=command`)
Deterministas, sin modelo. Ejemplos:

En un mensaje normal (escrito o nota de voz) se hacen al momento, sin pasar por el modelo, cuando nombran la tele («baja el volumen de la tele») o una tele por su nombre («pon Netflix en el salón»), y también durante 3 min tras otra orden de tele («abajo», «atrás», «sube el volumen»), salvo un «ok/vale/sí» suelto, abrir algo que no es app de tele o si nombra el PC. Con hora o condición, o cualquier otra cosa, contesta el modelo como siempre.

| Dices | Hace |
|---|---|
| «apaga la tele» / «enciende la tele» / «apágala» / «enciéndela» / «apaga el televisor» | `power` (ver encendido por red) |
| «pon la tele» / «pon la tv» / «ponme la tele» (solas, sin destino) | encender (decisión de Nico, 30-oct-2026); si ya estaba encendida contesta «La tele ya estaba encendida.» |
| «volumen a 20» | volumen absoluto (necesita Glasshouse) |
| «sube el volumen», «baja 5», «más alto» | pulsaciones del mando (`volumeStep`, sin Glasshouse) |
| «volumen +», «volumen -5», «vol −», «canal +», «canal -» | como los botones del mando: paso de volumen (3 / N); canal arriba/abajo |
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
| «sube (el volumen) hasta 30», «volumen hasta 30»; «canal más/menos», «sintoniza el 5»; «pausa el partido/capítulo», «para la música», «dale play», «sigue reproduciendo»; «modo gaming» | volumen N; canal; pausa / play; imagen juego |
| «sube a 30», «baja a 10», «pon la tele a 15», «ponla a 20» | volumen a ese número |
| «súbele un par (de puntos)», «baja dos puntitos»; «cambia al 7», «cámbiala al 24»; «apaga ya la tele» | paso de volumen (2 / N); canal; apagar |
| «volumen más/menos», «volumen máximo/mínimo»; «desmutea», «enciende el sonido»; «para / continúa el vídeo»; «pásate al 7»; «pulsa intro»; «ve a youtube» (solo apps conocidas) | paso de volumen; volumen 100 / 1; quitar silencio; pausa / play; canal; OK; abrir app |
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

## Varias teles en la misma wifi

- `pa tv buscar` (o `pa tv descubrir`) lista las teles de la red (LG y Sony) por SSDP; solo lectura, nada sale en pantalla. Solo cuenta aparatos con IP local, y el XML de cada uno se pide a su propia IP.
- `pa tv setup` sin IP busca las LG: si hay una sola sin emparejar la empareja; si hay varias, dice qué `pa tv setup <ip>` usar.
- `pa tv teles` lista las emparejadas (una tele emparejada antes del registro sale sola, sin reescribir nada); `pa tv usar <ip|nombre>` cambia la activa; `pa tv nombre <ip> salón` le pone nombre (sin tildes ni mayúsculas al buscarla).
- Si el router le cambia la IP a una tele (DHCP), `pa tv buscar` la reconoce por su MAC o su UUID UPnP y actualiza la IP guardada.
- `pa tv wake <ip|nombre>` enciende por red esa tele; sin nada, la activa.
- Las órdenes pueden nombrar la tele (por chat, `/tv` o `pa tv orden`): «baja el volumen de la tele del salón», «enciende la del dormitorio», «pon Netflix en el dormitorio». Sin nombre van a la activa, como siempre. El nombre tiene que ser el de una tele guardada (`pa tv nombre`, o la última palabra de su nombre UPnP, p. ej. «Dormitorio» en «[LG] webOS TV Dormitorio»). Con varias teles, un sitio que no es ninguna («la tele del garaje») o dos teles en una orden hacen que pregunte sin tocar ninguna. Una orden a otra tele no cambia la activa; su Glasshouse solo se busca en su propia IP y, si se volvió a emparejar, la clave nueva va a su entrada. Si no contesta en su IP, se busca por MAC/UUID y se reintenta una vez (solo si no llegó a conectar).
- Roku (y teles con Roku dentro: TCL, Hisense…): `pa tv buscar` los ve y `pa tv setup-roku <ip>` los guarda (sin aviso en pantalla: usa su API local ECP, puerto 8060). Órdenes en palabras con su nombre («baja el volumen de la tele del dormitorio») o, si es la activa, sin nombre: encender/apagar, subir/bajar volumen por pasos, silencio (alterna), flechas/OK/atrás/inicio, play/pausa y abrir Netflix, YouTube, Prime Video, Disney+, Spotify o Apple TV. El volumen exacto, canales y entradas no existen en ECP: lo dice sin tocar la tele. «¿Qué está viendo?» dice la app en pantalla y, si reproduce, por dónde va (o que está en reposo). Si el Roku contesta 403, hay que permitirlo en Ajustes > Sistema > Ajustes avanzados > Control por apps móviles > Acceso a la red.
- Samsung Tizen (2016 en adelante): `pa tv buscar` las ve y `pa tv setup-samsung <ip>` las empareja (pulsa «Permitir» en la tele; la clave se guarda en su entrada, nunca en la de la LG). Órdenes en palabras con su nombre o, si es la activa, sin nombre: apagar, encender por red (Wake-on-LAN con la MAC que da la propia tele), volumen por pasos, silencio (alterna), flechas/OK/atrás/inicio, play/pausa y abrir Netflix, YouTube, Prime Video, Disney+, Spotify o Apple TV. El volumen exacto, canales por número y «qué está viendo» no están en su API local. Si la rechaza: Ajustes > General > Gestor de dispositivos externos > Gestor de conexión de dispositivos.
- `pa tv usar` a otra tele guarda antes en el registro la tele de antes (la emparejada solo en las claves sueltas), para no perder su clave.
- Windows: el descubrimiento usa multicast UDP 1900. Si `pa tv buscar` no ve nada con la tele encendida, permite Node.js en «Redes privadas» en el Firewall de Windows (el aviso sale la primera vez) y comprueba que la wifi del PC es de tipo «Privada».

## Modo cine (`action=scene scene=cine`)
Encender si hace falta → quitar silencio → volumen 20 (o `level`) → abrir la app pedida (`appId`) → aviso en pantalla. Cada paso informa de su resultado; sin Glasshouse, volumen y silencio se omiten; si no se puede encender, la rutina para.

## Conexión y errores
- Si la tele rechaza la conexión al momento (recién despertada), se reintenta una vez; antes de conectar no se ha enviado nada, así que no se duplica ninguna orden. Un rechazo tras conectar nunca se repite.
- Los errores explican qué significan en castellano («No llego a la tele…», «Hay que volver a emparejar: pa tv setup <ip>», «La orden salió pero la tele no contestó… no la repito») y conservan el detalle técnico.
- Las teclas (tvKey) esperan 5 s como máximo a que abra el socket de botones y dan 800 ms de margen tras enviar. Si tu tele es lenta: `PA_TV_KEY_TIMEOUT_MS` (1000–30000) y `PA_TV_KEY_GRACE_MS` (50–5000).
- Rapidez: Asistenta deja abierta la conexión con la LG (y el socket de botones) entre órdenes y la cierra tras 60 s sin uso, así que cinco flechas seguidas tardan medio segundo y no siete. Entre teclas deja la pausa de las ráfagas (`PA_TV_KEY_GAP_MS`, 150 ms). Knob: `PA_TV_SESSION_IDLE_MS` (0 = abrir y cerrar en cada orden, como antes; 5000–600000). Si Glasshouse no contesta, durante 2 min abrir apps, avisos y encendido van directos por SSAP sin esperarlo.

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
