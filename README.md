# Asistenta

**Un asistente personal por Telegram, con memoria, objetivos de varios días y herramientas para trabajar en tu ordenador.**

El daemon corre en tu máquina. El panel web local ofrece chat, aprobaciones, sesiones, memoria, estado y auditoría; comparte el flujo de permisos de Telegram. Las funciones de escritorio necesitan una sesión Windows interactiva.

> **Estado:** proyecto en desarrollo. Tener una función en el código no garantiza que esté configurada ni validada en tu equipo. Los mensajes que recibe el proveedor LLM salen hacia ese proveedor. Los nombres de presets no garantizan cuota ni precio cero.

## Qué puedes hacer

| Área | Qué incluye | Condiciones |
| --- | --- | --- |
| Conversación | Telegram y chat en el panel local | Bot, usuario autorizado y proveedor configurados |
| Memoria | Contexto persistente, sesiones y búsqueda | El contenido y su alcance dependen de la configuración |
| Objetivos | Plan propuesto, activación humana, pasos y ejecución programada | Límites de objetivos activos y de ejecuciones diarias |
| Navegador y escritorio | Herramientas web y control del ordenador | Escritorio en Windows; sitios, acceso y permisos propios |
| Aprobaciones | Decisiones pendientes en Telegram y en el panel | No sustituye la revisión del resultado ni autoriza cualquier acción |
| Funciones opcionales | Voz, correo, TV y control de iPhone | Requieren sus dependencias, equipos y configuración; no se activan al instalar el chat |

### Un objetivo, de principio a fin

1. Describe lo que quieres conseguir y sus límites.
2. Asistenta propone un plan. Solo se activa después de la confirmación humana y de pasar por los permisos correspondientes.
3. Ejecuta los pasos en su cadencia, guarda el avance y comunica novedades o bloqueos.
4. Si falta una decisión, se detiene para pedirla. Un paso marcado como completado no certifica por sí solo la calidad del resultado.

Los objetivos se guardan en SQLite con su ámbito de conversación. El panel incluye una **vista de solo lectura de los objetivos del propietario**, con sus estados, bloqueos y pasos. No permite activar, pausar ni cancelar objetivos desde esa vista. Un tablero editable y un estado separado de revisión serían trabajo futuro, no capacidades disponibles por esta guía.

## Contenido

- [Antes de empezar](#antes-de-empezar)
- [Preparar el código](#preparar-el-código)
- [Configuración sin secretos](#configuración-sin-secretos)
- [Secretos y Telegram](#secretos-y-telegram)
- [Comprobar y arrancar](#comprobar-y-arrancar)
- [Panel web local](#panel-web-local)
- [Arranque automático](#arranque-automático)
- [Desarrollo y QA](#desarrollo-y-qa)
- [Cómo está organizado](#cómo-está-organizado)
- [Seguridad y límites](#seguridad-y-límites)

## Antes de empezar

- Node.js 24 o posterior y npm. El proyecto exige esa versión en `package.json`.
- Git para obtener el código.
- Un bot de Telegram y tu identificador numérico de usuario.
- Acceso a un proveedor compatible. Los nombres de modelos y los presets del código no garantizan cuota ni precio cero.
- Windows con sesión interactiva para control de escritorio. En Linux o sin escritorio, usa `PA_DESKTOP=off`; no supone cobertura de todas las funciones de Windows.

No uses una cuenta o sesión real para pruebas automatizadas. No pegues claves en incidencias, chats ni capturas.

## Preparar el código

Desde la raíz del repositorio:

```sh
node --version
npm ci
npm run build
node dist/cli.js --help
```

En los comandos siguientes se usa `node dist/cli.js` para no depender de un `pa` instalado globalmente. La compilación crea `dist/`; no descarga ni inicia un proveedor LLM. Algunas dependencias pueden descargar binarios al instalarse. Para el navegador Chromium incluido:

```sh
npx playwright install chromium
```

Con `PA_DESKTOP=off`, `doctor` omite los chequeos de escritorio Windows (pantalla, cámara, micrófono, ventanas). Instala también las dependencias de sistema que Playwright indique para tu plataforma. No hace falta instalar browserd, Docker ni funciones de TV para el chat básico.

## Configuración sin secretos

Copia `.env.example` a `.env` y ajusta solo las opciones que necesites. El CLI carga el `.env` del directorio de trabajo mediante el parser de Node antes de cargar la configuración. Las variables ya presentes en el entorno tienen prioridad. Puedes pasar el archivo expresamente para hacer visible qué configuración usas:

```sh
node --env-file=.env dist/cli.js doctor
```

El archivo de ejemplo no contiene claves. No subas `.env` ni el directorio de estado al repositorio. Si eliges otra carpeta con `PA_STATE_DIR`, usa la misma para todos los comandos y para el arranque automático.

El preset por defecto del código es `opencode`. También existen `openrouter` y `opencode-local`; este último requiere un servidor OpenCode ya configurado, accesible en la URL local seleccionada y con su jaula validada. Esta guía no lo instala ni cambia de proveedor automáticamente.

## Secretos y Telegram

El almacén por defecto usa DPAPI en Windows, ligado al usuario y máquina. En otros sistemas utiliza un archivo portable con permisos restringidos; **no es cifrado DPAPI**. No cambies a portable en Windows para esquivar un fallo del vault.

1. En Telegram abre BotFather desde su perfil verificado, crea un bot con `/newbot` y guarda el token en privado. No lo compartas con bots de terceros.
2. Obtén tu propio identificador numérico de usuario mediante un método que controles. No es tu nombre `@usuario` ni el identificador del bot. La autodetección por `/start` todavía no está implementada.
3. Inicializa el almacén una sola vez:

   ```sh
   node --env-file=.env dist/cli.js vault init
   ```

4. Los nombres que `serve` necesita son `telegram:botToken`, `telegram:allowedUserIds` (IDs separados por comas) y `provider:apiKey`, cuando el proveedor requiere una clave. El comando actual `vault set <clave> <valor>` recibe el valor como argumento: puede quedar en historial y en la lista de procesos. No pegues secretos en una terminal compartida, grabada o con historial sincronizado. Esta guía no presenta ese camino como entrada secreta segura. `vault set-stdin <clave>` permite una entrada por pipe privado sin valor en argumentos y rechaza una terminal con eco; consulta [`docs/vault-stdin-qa.md`](docs/vault-stdin-qa.md). No normaliza el secreto: conserva espacios y BOM inicial; solo retira un salto final LF/CRLF. No escribas el secreto en una línea echo/printf, que lo vuelve a poner en el historial. `node dist/cli.js setup` ofrece una configuración local guiada parcial; consulta [`docs/setup-qa.md`](docs/setup-qa.md) para sus límites. No activa autostart ni hace llamadas reales para validar Telegram/modelo.

   En el backend portable puedes preparar de forma privada el archivo `secrets.json` del directorio de estado, con un objeto JSON cuyos nombres sean esas claves y cuyos valores sean cadenas. Limita el directorio al usuario y el archivo a `600` en Unix **antes** de escribir secretos. No uses `vault get` para comprobarlos: imprime el valor. `vault list` muestra solo nombres.

Por defecto el estado está en `~/.local/share/personal-agent`, también bajo el perfil del usuario en Windows. Guarda allí los datos solo en una cuenta de sistema que controles. DPAPI no ofrece recuperación al mover el vault a otra máquina: conserva una forma privada de rotar las claves. Las copias de seguridad no incluyen el vault de forma intencionada.

## Comprobar y arrancar

```sh
node --env-file=.env dist/cli.js doctor
node --env-file=.env dist/cli.js diagnose
```

`doctor` comprueba el entorno local. `diagnose` lee evidencia local y puede incluir rutas, logs o acciones: revisa el resultado antes de compartirlo. Ninguno prueba por sí solo que el chat completo funcione.

`llm-health` hace solicitudes reales a proveedores configurados. Puede gastar cuota y, según el plan, dinero; no lo ejecutes como comprobación inocua:

```sh
node --env-file=.env dist/cli.js llm-health
```

Antes de arrancar, comprueba que todo está en su sitio (lista verde/rojo con el arreglo de cada fallo; no gasta llamadas al modelo):

```sh
node --env-file=.env dist/cli.js iniciar --solo-comprobar
```

Cuando hayas comprobado el acceso y sus condiciones, arranca en primer plano (`iniciar` sin opciones comprueba y arranca; `serve` arranca directamente):

```sh
node --env-file=.env dist/cli.js iniciar
```

En Windows, `levantar.bat` hace lo mismo con doble clic.

Envía `/start` a tu bot desde el usuario autorizado. Un comando que responde no prueba que una petición al modelo funcione: prueba después una pregunta genérica, sin datos privados. Si faltan credenciales o el token es inválido, corrige la configuración; no abras el bot a todos los usuarios para resolverlo.

Para detener un arranque en primer plano, usa Ctrl+C y espera al cierre. No mates un proceso solo por un PID copiado de un archivo.

- `status` y `watchdog --status` son consultas puntuales del PID y latido; no confirman salud Telegram/LLM ni supervisión instalada.
- En Linux, solo en modo servidor, `node --env-file=.env dist/cli.js stop` usa control local autenticado y exige cierre limpio y propiedad liberada. Requiere `flock`, directorio de estado privado y un daemon arrancado con esta versión. No puede detener un daemon antiguo que no publique ese control. Un timeout o cierre no limpio es un fallo, no una invitación a matar por PID.
- En Windows todavía no hay controlador `stop`/`restart`. No uses la cobertura Linux como prueba de tu PC Windows.
- `restart` se rechaza sin cambiar el daemon porque no se puede verificar si un supervisor lo relanzará.
- La supervisión continua aún no está disponible. `setup` guía la configuración local parcial, sin activar vigilancia. El instalador de Windows cubre procesos que terminan, no cuelgues de procesos que siguen vivos. No se afirma que haya un watchdog instalado.

En Linux el nuevo controlador exige que el directorio de estado sea privado (700, propietario actual, sin symlink) y que la ruta del socket quepa en el límite Unix. Si una instalación antigua tiene permisos abiertos, el arranque falla cerrado: revisa primero su contenido y propietario antes de restringirlos. No cambia esos permisos silenciosamente. `PA_DESKTOP=on` no se admite en este camino Linux.

## Panel web local

Es opcional: configura `PA_WEB_PORT` y `PA_WEB_TOKEN` por un canal privado antes de arrancar. Sin token, el daemon no inicia el panel. Escucha por defecto en loopback, sus API exigen Bearer y solo responde a los nombres locales (`127.0.0.1`, `localhost`, `[::1]`): cualquier otra cabecera Host recibe 403, lo que corta el DNS rebinding. Si sirves el panel por un proxy propio (p. ej. `tailscale serve`), añade su nombre exacto en `PA_WEB_ALLOWED_HOSTS` (separados por comas). No publiques el token, su URL inicial ni el almacenamiento del navegador. No expongas el puerto a Internet como si tuviera gestión de usuarios.

El panel y Telegram ven las mismas aprobaciones pendientes. La vista web no implica que todas las herramientas estén configuradas o que el daemon esté supervisado.

## Arranque automático

Consulta [`deploy/windows/README.md`](deploy/windows/README.md). No lo actives hasta comprobar el arranque manual. El script usa la raíz del repositorio como directorio de trabajo; el CLI carga desde allí el `.env` opcional. Las variables ya presentes en el entorno del usuario de la tarea tienen prioridad sobre el archivo. No coloques secretos en el comando de la tarea. No se ha validado una instalación nativa Windows en esta ronda de QA.

## OCR local (opcional)

Asistenta puede sacar el texto de una imagen o un PDF escaneado con un motor OCR que corre en tu PC: sin red (salvo la primera descarga de los pesos), sin APIs de pago y sin usar tus claves del modelo. Está **apagado por defecto**; al activarlo aparece la herramienta `ocr_local`, que solo lee ficheros dentro de la carpeta de trabajo (y de `PA_OCR_WATCH_DIR` si la tienes). La herramienta `ocr` de siempre (texto de la pantalla con el OCR de Windows) no cambia.

Instalar (PowerShell, en la carpeta de Asistenta; necesita Python 3.10+ con el lanzador `py`):

```powershell
scripts\ocr-sidecar\setup.ps1              # PP-OCRv5 (por defecto)
scripts\ocr-sidecar\setup.ps1 -Model glm   # GLM-OCR (máxima calidad)
```

En Linux/WSL: `scripts/ocr-sidecar/setup.sh [ppocr|glm]`. Después, en `.env`: `PA_OCR_LOCAL=1` y, si quieres GLM-OCR, `PA_OCR_MODEL=glm`. Reinicia Asistenta.

Medido el 30-oct-2026 con 8 páginas en español (ticket, captura web, escaneo, tabla, foto inclinada, letra pequeña, ES/EN, letra manuscrita), solo CPU:

| Motor | Acierto | s/página | RAM | Licencia |
| --- | --- | --- | --- | --- |
| PP-OCRv5 (RapidOCR, ONNX) — por defecto | 94,5 % | 1,3 | 0,8 GB | Apache-2.0 |
| GLM-OCR (`zai-org/GLM-OCR`) — `PA_OCR_MODEL=glm` | 98,5 % | 8,9 | 3,1 GB | MIT |

GLM-OCR descarga unos 2 GB de pesos la primera vez y necesita PyTorch (CPU). PP-OCRv5 es más flojo en capturas de webs con menús; GLM-OCR, en letra muy pequeña. Los PDF se leen hasta 20 páginas. Si el motor no está instalado, Asistenta te lo dice con el comando para instalarlo.

## Desarrollo y QA

```sh
npm run typecheck
npm run lint:check
npm run build
npm test
```

El runner ejecuta una fase general y una fase serial para pruebas de recursos. Las pruebas de navegador/escritorio requieren sus dependencias; las pruebas Linux no sustituyen la verificación de Windows. Un test con un proceso simulado no prueba que un daemon real se haya detenido.

- [`ROADMAP.md`](ROADMAP.md): contexto de trabajo y deudas; puede contener planes aún no implementados.
- [`docs/voz-piper.md`](docs/voz-piper.md): voz local de respaldo con Piper (opt-in `PA_PIPER_MODEL`).
- [`docs/resumen-diario.md`](docs/resumen-diario.md): resumen de la mañana (opt-in `PA_BRIEFING=1`) y `/resumen hoy`.
- [`docs/startup-preflight-qa.md`](docs/startup-preflight-qa.md): validación de arranque y sus límites.
- [`docs/diagnose-cli-qa.md`](docs/diagnose-cli-qa.md): diagnóstico local y QA.
- [`docs/daemon-stop-qa.md`](docs/daemon-stop-qa.md): parada Linux, pruebas y límites.
- [`docs/tv-ordenes.md`](docs/tv-ordenes.md): órdenes a la tele LG y encendido por red; `pa tv mac auto` lee la MAC de la tele de la red (con la tele encendida).
- [`docs/skills-incluidas.md`](docs/skills-incluidas.md): skills de ingeniería incluidas (diagnosticar bugs, TDD), que solo se cargan al programar.
- Rutinas programadas: si el PC estaba apagado o dormido a la hora de una rutina, al volver se ejecuta UNA vez con retraso (avisando de la hora a la que tocaba) si no ha pasado la ventana de gracia (mitad del periodo, entre 2 min y 2 h); si ya pasó, no se ejecuta y queda anotada como perdida. Desactivar: `PA_ROUTINE_CATCHUP=0`.
- Evolución semanal (`src/evolve`): un candidato solo se promueve con la checklist de verificación completa (spec escrita, sin ficheros prohibidos, medición válida, sin más fallos que la base) y deja `state/evolve/promovido-<n>.receipt.md` junto al parche.

## Cómo está organizado

```text
src/cli.ts          Arranque y conexión de servicios
src/channels/      Canales de conversación
src/tools/         Herramientas disponibles para el agente
src/goals/         Persistencia, ejecución y avisos de objetivos
src/webui/         Panel local y API autenticada
src/               Memoria, permisos, proveedores y servicios
browserd/          Servicio de navegador opcional
deploy/            Instrucciones por plataforma
test/, qa/         Tests y escenarios de comprobación
docs/              Guías técnicas y límites de QA
```

No es necesario arrancar todos los componentes para usar el chat básico. Consulta la guía de cada función antes de añadir servicios.

## Seguridad y límites

- No uses datos, cuentas ni sesiones reales en pruebas automatizadas.
- No subas secretos, directorios de estado, capturas privadas ni logs sin revisar.
- El almacén portable no equivale al cifrado DPAPI de Windows. Revisa [la entrada segura por stdin](docs/vault-stdin-qa.md).
- Navegar, ejecutar una herramienta y obtener un resultado son hechos distintos. Una prueba con mocks o en Linux no certifica el control del escritorio Windows.
- Los servicios externos tienen sus propios términos, cuotas y políticas de datos. Revisa el plan antes de activar una clave o una integración.
- Puerta de exfiltración: en cuanto un turno lee algo privado (archivos, memoria, correo, documentos, pantalla, terminal…), una petición de `fetch`, `download` o del navegador con datos (query, ruta larga, usuario en la URL o subdominio largo) a un dominio que el turno aún no ha visitado pide aprobación enseñando la URL completa. Antes de leer nada privado, navegar sigue siendo libre. `PA_TAINT_GATE=0` la apaga.
- El código de delegación no se presenta aquí como un sistema multiagente operativo: su existencia no prueba conexión al daemon.

## Contribuir

Propón cambios pequeños, explica el problema y añade una comprobación que lo reproduzca. Usa `npm run lint:check` para revisar sin reescribir archivos. No describas una prueba local como validación de una instalación ajena. Separa las funciones implementadas, la configuración pendiente y las propuestas del [roadmap](ROADMAP.md).

## Licencia

`package.json` declara MIT. Este checkout no incluye un archivo `LICENSE`; antes de redistribuir código, confirma el texto y los avisos aplicables con el mantenedor. Esta documentación no añade ni cambia una licencia.

`pa autostart install` también registra un vigilante (tarea «Asistenta-vigilante», al iniciar sesión y cada 5 min) que vuelve a arrancar Asistenta si no está en marcha; si la paras con `pa stop`, la deja apagada hasta reiniciar el PC o `pa iniciar`. `PA_WATCHDOG=0` lo desactiva y `pa autostart status` dice cómo está.

Asistenta también se actualiza sola desde `main` (`PA_AUTOUPDATE=1` por defecto): espera a estar libre, hace fast-forward, compila, se reinicia y te avisa por Telegram con las novedades; si algo falla vuelve sola a la versión anterior. `pa autoupdate status|now|off|on`. Detalles en [docs/windows-startup.md](docs/windows-startup.md#autoactualización-desde-main).
