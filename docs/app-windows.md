# Asistenta como app de Windows

Asistenta se instala como cualquier programa (siguiente, siguiente, listo), corre en segundo plano sin ventanas de consola y tiene un icono junto al reloj. No hace falta tener Node instalado: el instalador lo trae dentro.

## Instalar

1. Abre `Asistenta-Instalador-<versión>.exe`.
2. Windows avisará con SmartScreen («Windows protegió su PC»): el instalador no está firmado, porque un certificado de firma cuesta dinero. Pulsa «Más información» y luego «Ejecutar de todas formas».
3. Elige la carpeta (de serie `%LOCALAPPDATA%\Asistenta`, sin pedir permisos de administrador).
4. Deja marcada «Arrancar Asistenta al encender el PC» si quieres que se encienda sola (usa el mismo arranque automático de siempre: tarea programada y vigilante).
5. Al terminar, «Configurar Asistenta ahora» te pide el token de Telegram y la clave del modelo, igual que `instalar.bat`. Después Asistenta se queda en segundo plano.

En el menú Inicio quedan «Asistenta», «Configurar Asistenta» y «Desinstalar Asistenta». También sale en «Agregar o quitar programas».

Instalar encima de una versión anterior conserva tu `.env`, tus claves y tu memoria.

## El icono junto al reloj

Verde: Asistenta está en marcha y da señales de vida. Rojo: parada o sin dar señales. Clic derecho:

- **Abrir panel**: abre el panel en `http://127.0.0.1:<puerto>/` (solo en este PC). Necesita `PA_WEB_PORT` y `PA_WEB_TOKEN` en el `.env`; la primera vez el panel te pide el token y luego lo recuerda. El icono no lee ni pasa el token.
- **Pausar / Reanudar**: la apaga (`pa stop`) o la vuelve a encender.
- **Reiniciar**: la apaga y la enciende.
- **Ver estado**: verde o rojo, con el detalle de `pa status`.
- **Ver registro**: abre la carpeta de registros.
- **Salir**: apaga Asistenta y quita el icono.

Si el arranque automático está instalado, el icono enciende Asistenta por su tarea, así el vigilante la sigue cuidando. Doble clic en el icono = «Ver estado».

## Desinstalar

Desde «Agregar o quitar programas» o «Desinstalar Asistenta». Quita el programa y el arranque con Windows. Tu `.env`, tus claves y tu memoria **se quedan**, salvo que marques «Borrar también mis datos, claves y configuración» (desmarcada de serie).

## Descargar el .exe ya hecho

Cada vez que se publica una versión en GitHub (pestaña «Releases» del repositorio), GitHub construye el instalador y lo adjunta a esa versión: descarga `Asistenta-Instalador-<versión>.exe` desde allí, sin compilar nada. Al lado va `Asistenta-Instalador.sha256` con su huella SHA-256 por si quieres comprobarlo. La etiqueta de la versión tiene que coincidir con la de `package.json` (por ejemplo `v0.2.0` y `0.2.0`); si no, GitHub no construye nada.

## Construir el .exe (para quien desarrolla)

En Linux o Windows con NSIS (`sudo apt-get install nsis` en Debian/Ubuntu):

```
npm ci
npm run build
npm run build:instalador
```

Sale `var/Asistenta-Instalador-<versión>.exe`. El script baja el Node portable oficial de nodejs.org (versión fija y SHA-256 comprobado) y las dependencias de producción para Windows x64. Nada de esto se sube a git.

## Lo que aún no hace

- Actualizarse sola: la carpeta instalada no viene de git, así que `pa autoupdate` dice que no puede. Para una versión nueva, instala el `.exe` nuevo encima (conserva tus datos).
- El verde del icono dice que Asistenta está viva; no comprueba aún la conexión con Telegram.
- Dictado: mientras exista `dictado.grabando` en la carpeta de datos, el punto se pone naranja (gancho para el dictado por voz).

`instalar.bat` y `levantar.bat` siguen funcionando igual para quien prefiera la carpeta con Node propio.
