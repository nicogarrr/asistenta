# Tele LG: órdenes, estado, encendido por red y modo cine

Todo pasa por la herramienta `tv` (lo usa el agente; tú se lo pides en Telegram con tus palabras).

## Órdenes naturales (`action=command`)
Deterministas, sin modelo. Ejemplos:

| Dices | Hace |
|---|---|
| «apaga la tele» / «enciende la tele» | `power` (ver encendido por red) |
| «volumen a 20» | volumen absoluto (necesita Glasshouse) |
| «sube el volumen», «baja 5», «más alto» | pulsaciones del mando (`volumeStep`, sin Glasshouse) |
| «silencio» / «apaga el sonido» / «quita el silencio» | `mute` |
| «canal 5», «pon la 1», «siguiente canal» | `channel` (dígitos + ENTER, CHANNELUP/DOWN) |
| «abre Netflix», «pon YouTube», «quiero ver DAZN» | `launch` por nombre |
| «pausa», «dale al play» | `media` |
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

- La MAC se guarda sola al emparejar (`pa tv setup <ip>`) si la tele la da; si no: `pa tv mac AA:BB:CC:DD:EE:FF` (Ajustes > General > Acerca de esta TV).
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
- `/tv <orden>` (solo tú, en tu chat privado): «/tv apaga la tele», «/tv abre Netflix», «/tv volumen a 15», «/tv modo cine», «/tv estado». Va directo a la tele, sin pasar por el modelo (0 tokens). Si no la entiende, lo dice y no hace nada.
