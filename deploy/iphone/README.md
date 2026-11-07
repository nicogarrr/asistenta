# iPhone con ESP32 (esp32-iphone-agent)

Asistenta maneja un iPhone real: ve la pantalla por AirPlay y toca con una ESP32-S3
que hace de raton y teclado USB. Sin Mac, sin cuenta de desarrollador, sin jailbreak,
sin instalar nada en el telefono. Upstream (MIT): https://github.com/onehumanbeing/esp32-iphone-agent,
fijado al commit `88a51030b5ec36564157bc778c7827b4dffb4b41`.

## Piezas

| Pieza | Donde corre | Que hace |
|---|---|---|
| ESP32-S3 | enchufada al iPhone | Se presenta como raton/teclado USB; ejecuta ordenes por wifi |
| UxPlay + servidor `hidagent` | Linux, macOS o **WSL2** en la MISMA red que el iPhone | Recibe la pantalla, calibra el puntero, lleva el modelo de vision |
| Tool `iphone` (este repo) | daemon de Asistenta | `status`, `screenshot`, `texto`, `run` (objetivo), `stop`, `home` |

La tool solo habla con la API local del servidor (`/api/status`, `/api/frame.jpg`, `/api/agent`...).
Cada `run`, `stop` y `home` **pregunta siempre** antes de ejecutarse (mueve un telefono real);
`status`, `screenshot` y `texto` son lecturas.

`texto` pasa la captura por el OCR que ya trae Windows (sin instalar nada) y devuelve la pantalla
como lineas `x y  texto`, con x e y en fracciones (0 a 1), las mismas que usa el servidor para tocar.
El modelo lee unos cientos de tokens en vez de una imagen y, si la pantalla es la de bloqueo o la del
codigo, lo avisa en cabeza para que no escriba nada. Idea tomada de phoneuse (MIT), ver
`THIRD_PARTY_NOTICES.md`. Sin probar con un iPhone real.

### Pasos sueltos (opcional, `PA_IPHONE_GESTOS=1`)

Por defecto Asistenta solo le da un objetivo entero al agente del servidor (`run`), que usa su propio
modelo y su propia clave. Con `PA_IPHONE_GESTOS=1` en el `.env`, el modelo de Asistenta maneja el
telefono paso a paso, leyendo la pantalla con `texto`:

| Accion | Que hace |
|---|---|
| `tocar` | toca en x, y (fracciones, como en `texto`) |
| `tocar_texto` | busca ese texto en la pantalla y toca su centro; si no esta o hay dos iguales, no toca |
| `escribir` | escribe en el campo con el foco (`\n` = Intro) |
| `tecla` | enter, backspace, esc, cmd+a... |
| `atras` | el gesto de volver |
| `desplazar` | baja o sube media pantalla (o lo que se pida, hasta 2) |
| `abrir_app` | Inicio (Cmd+H), buscar (Cmd+Espacio), el nombre e Intro |

- **Cada paso pide permiso a Nico** en Telegram (la Gate los trata como opacos). Despues de cada paso
  devuelve la pantalla nueva en texto.
- No escribe ni pulsa teclas si la pantalla es la de bloqueo o la del codigo, ni si no puede leerla para
  comprobarlo. No toca la isla dinamica (arriba en el centro): abre «Detener duplicacion» y se corta la pantalla.
- No se mezcla con el agente del servidor: si hay un `run` en marcha, espera a que pare.
- El teclado de la ESP32 es de EE. UU.: no escribe tildes ni enes (se rechazan antes de mandar nada) y, si en
  el iPhone el teclado fisico esta en espanol, algunos signos pueden salir cambiados (Ajustes > General >
  Teclado > Teclados fisicos: EE. UU.; sin comprobar).
- Las recetas vienen de phoneuse, que las probo por Bluetooth en un iPhone 17 Pro con iOS 26. **Con la ESP32 por
  USB no se han probado.**

## Alta guiada

Pidele a Asistenta "conecta el iPhone" (tool `iphone`, `action=setup`, solo lectura): consulta al servidor y lista los
pasos (servidor, ESP32, pantalla en directo, calibrado, modelo) con lo hecho marcado y el siguiente a seguir.
Idea tomada del onboarding de ananhq/anan-iphone-use. No hay pareo por codigo ni exportacion de config MCP: el
servidor hidagent no los tiene (la tool habla con su API local), asi que no se simulan. Tampoco puede saber si
AssistiveTouch esta activado: eso solo lo ve la persona.

## Limites conocidos (declarados)

- El servidor upstream **no corre en Windows nativo** (usa `pass_fds` y `/proc`). En el PC de Nico va en **WSL2**.
- Con WSL2 hay dos requisitos de red SIN verificar en esta maquina: el iPhone tiene que **descubrir** el
  receptor AirPlay (mDNS) y la ESP32 tiene que **alcanzar** el puerto 7300 del PC. Se resuelven con
  `networkingMode=mirrored` (Windows 11 22H2 o posterior). Si el iPhone no ve "iPhone Agent",
  el plan B es una maquina Linux pequena en casa (cualquier portatil viejo o Raspberry Pi 4/5) con el mismo script.
- Solo ve pixeles: no lee notificaciones ni estado interno. Si se corta el AirPlay o el telefono se bloquea,
  la tarea se queda parada.
- El modelo gratis (Gemini AI Studio) tiene tope diario de peticiones y cada paso es una peticion: una tarea larga puede
  agotarlo. No se ha probado con un iPhone real (la placa no esta conectada).
- Pegar contrasenas o codigos (TikTok, bancos) a traves de este agente: no lo hagas sin pedirlo expresamente.

## Preparacion (una vez, sin la placa)

1. En PowerShell (admin), activa WSL2 + Ubuntu si no lo tienes: `wsl --install -d Ubuntu`.
2. `%UserProfile%\.wslconfig`:
   ```
   [wsl2]
   networkingMode=mirrored
   ```
   y en Ubuntu `/etc/wsl.conf`:
   ```
   [boot]
   systemd=true
   ```
   Luego `wsl --shutdown` y abre Ubuntu otra vez.
3. Permite la entrada al puerto 7300/8890 en el firewall de Hyper-V/WSL (PowerShell admin):
   `Set-NetFirewallHyperVVMSetting -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -DefaultInboundAction Allow`
   (o una regla concreta para 7300 y 8890).
4. Dentro de Ubuntu: `bash deploy/iphone/install-wsl.sh`, y despues pega tu clave en `~/esp32-iphone-agent/server/.env`
   (`LLM_API_KEY`, la de Gemini AI Studio; permisos 600; jamas por chat ni en el repo).
5. En Windows, graba la ESP32 (cuando la tengas a mano): `powershell -ExecutionPolicy Bypass -File deploy\iphone\flash.ps1 -WifiSsid ... -ServerHost <IP LAN del PC> -Port COMx`.
6. En el vault de Asistenta: `iphone:url` = `http://127.0.0.1:8890` (con WSL2 mirrored) o la IP del servidor.
   (Alternativa: variable `PA_IPHONE_URL`.)

## Dia que enchufas la placa

1. iPhone: Ajustes > Accesibilidad > Tocar > **AssistiveTouch** activado.
2. Enchufa la ESP32 al USB-C del iPhone (el 13 es Lightning: adaptador Lightning a USB para camara). Aparece un puntero redondo.
3. En Ubuntu: `bash deploy/iphone/run.sh`.
4. iPhone: Centro de control > Duplicar pantalla > **iPhone Agent**.
5. Abre `http://localhost:8890` > Manual controls > **Calibrate** (se calibra solo en unos segundos).
6. Pidele a Asistenta: "mira el estado del iPhone" (tool `iphone` action=status) y despues una tarea.

## Actualizar Asistenta

`git pull && npm ci && npm run build` y reinicia el daemon.
