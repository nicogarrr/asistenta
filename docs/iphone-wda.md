# Ver y tocar el iPhone desde Asistenta (WebDriverAgent, experimental)

> **Estado:** está hecho y probado solo con un WebDriverAgent simulado. **No se ha probado con un iPhone real.** Es opcional y viene apagado. Asistenta puede acompañarte en estos pasos: pídele «ayúdame a conectar el iPhone» y ve contestando a lo que te diga `/iphone diagnostico`.

## Qué es

[WebDriverAgent](https://github.com/appium/WebDriverAgent) (WDA, open source) es un pequeño servidor que corre en el iPhone como una «prueba de interfaz» de Apple. Desde el PC se le puede pedir la pantalla, qué hay en ella (botones, textos y sus posiciones), y que toque o escriba. Asistenta lo usa con la herramienta `iphone_pantalla`:

- **Mirar** (estado, pantalla, leer) no pide permiso. `leer` da una línea por elemento con texto («Wi-Fi», «Enviar»…), su centro en puntos para tocar y si un interruptor está en sí o no; gasta mucho menos que una captura. `leer` con `crudo` da el árbol entero.
- **Tocar, escribir, abrir una app o ir al inicio** te lo pregunta en Telegram **cada vez**.

Es lo mismo que hace POKI, pero hecho dentro de Asistenta y sin Mac.

## Lo que hace falta

- El PC con Windows y un cable USB para la primera vez.
- El iPhone desbloqueado mientras Asistenta lo usa.
- **Modo desarrollador** en el iPhone, y en Ajustes de desarrollador, **UI Automation** activado.
- [go-ios](https://github.com/danielpaulus/go-ios) (open source, funciona en Windows): `npm install -g go-ios`.
- Un Apple ID para firmar WebDriverAgent. Con uno **gratis** la firma dura **7 días** y luego hay que repetir el paso 4.

## Pasos

1. **Drivers del iPhone en Windows.** Instala la app «Dispositivos Apple» (o iTunes) desde la Microsoft Store. Conecta el iPhone por USB, desbloquéalo y pulsa **Confiar** en este ordenador.
2. **go-ios.** En una terminal: `npm install -g go-ios`, y luego `ios list` (debe salir tu iPhone). Para iOS 17 o posterior, copia `wintun.dll` (de https://git.zx2c4.com/wintun) en `C:\Windows\System32`, como dice la guía de go-ios.
3. **Modo desarrollador.** `ios devmode enable`, o en el iPhone: Ajustes → Privacidad y seguridad → Modo desarrollador. El iPhone se reinicia. Después, en Ajustes → Desarrollador, activa **UI Automation**. Monta la imagen de desarrollador con `ios image auto`.
4. **Instalar WebDriverAgent firmado.** `ios ui download` baja WDA ya compilado y dice dónde lo deja. Para firmarlo:
   - con certificado y perfil propios: `ios ui install`, o `ios sign app` con tu .p12 y tu perfil;
   - con un Apple ID gratis: firma e instala ese WDA con una herramienta de Windows como Sideloadly o AltServer (dura 7 días).

   Sin comprobar aún: qué combinación funciona con un Apple ID gratis. Es lo primero que hay que probar.
5. **Arrancar WDA y el túnel**, cada vez que reinicies el PC (o déjalo en una tarea programada):
   - `ios tunnel start` (iOS 17+, en una terminal como administrador, y se queda abierto)
   - `ios runwda` (en otra terminal, se queda abierto)
   - `ios forward 8100 8100` (en otra, se queda abierto)
6. **Activar en Asistenta.** En `.env` añade `PA_IPHONE_WDA=1` (y `PA_IPHONE_WDA_URL=http://127.0.0.1:8100` si usas otro puerto) y reinicia Asistenta. O pídeselo a ella: «pon PA_IPHONE_WDA=1 en el .env».
7. **Comprobar.** Escribe **`/iphone diagnostico`** en Telegram. Dice qué está bien y cuál es el siguiente paso si algo falta.

## Riesgos (léelos)

- Mientras el modo desarrollador y UI Automation estén activados, un programa en el PC con WDA puede tocar tu iPhone. Asistenta te pregunta cada toque, pero apágalos si dejas de usarlo.
- Una orden puede quedarse «sin saber si se ha hecho» (el iPhone no contestó a tiempo). Asistenta mira la pantalla antes de repetirla y nunca la repite a ciegas.
- Cada iOS nuevo puede romper WDA o go-ios hasta que los actualicen.
- Con Apple ID gratis, cada 7 días hay que volver a firmar (paso 4).

## Más adelante (sin WDA)

POKI enseña otra vía: hablar directamente con los servicios de depuración de Apple (pantalla, accesibilidad y toques) con la librería open source [idevice](https://github.com/jkcoxson/idevice) (MIT). Así no hay app que firmar ni nada que renovar cada 7 días, y funciona por wifi o Tailscale después de emparejarlo una vez por USB. Aún no se ha probado en Windows. Si WDA se queda corto, el siguiente paso es esa vía.
