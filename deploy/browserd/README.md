# Deploy del sidecar browserd en el PC (Windows)

Un comando instala y valida el sidecar Camoufox en este PC:

```powershell
git pull
powershell -ExecutionPolicy Bypass -File deploy\browserd\setup-browserd.ps1 -Start -Bench -EnableEngine
```

Que hace, en orden:

1. Localiza Python 3.12+ (`py -3.14/-3.13/-3.12/-3` o `python`; acepta
   cualquier version >= 3.12). Si no hay, avisa y para: instalalo desde
   [python.org](https://www.python.org) marcando "Add python.exe to PATH" y
   repite el comando.
2. Crea el entorno virtual `browserd\.venv` (no toca ningun otro Python). Si
   ya existe pero usa Python < 3.12 o esta roto, lo recrea.
3. `pip install -r browserd\requirements.txt`.
4. `python -m camoufox fetch` (descarga el Firefox parcheado; solo la
   primera vez).
5. Smoke real: levanta Camoufox con la barrera de red contra un servidor
   loopback (redirect + subrecurso), en puerto efimero y con perfiles
   temporales, y exige PASS. El cierre es parte del contrato: la sesion se
   borra via API, uvicorn se apaga y se espera su salida ANTES de soltar el
   directorio temporal; un fallo de limpieza es un FAIL, no un aviso.
6. `-Start`: arranca el sidecar en segundo plano con configuracion EXPLICITA
   (`BROWSERD_HOST=127.0.0.1`, `BROWSERD_PORT=7701`, token vacio) para el
   proceso hijo - no hereda sorpresas del entorno. Solo lo da por bueno si
   `/health` responde el contrato browserd (`service="browserd"`, `version`,
   capability `read`); si el puerto lo ocupa otra cosa o el proceso no
   valida en 30s, lo mata y para con error. Logs en `browserd\logs`
   (sobrescritos en cada arranque).
7. `-Bench`: bateria anti-bot real (`browserd\bench\results.json`) con la IP
   residencial de este PC - la cifra que compara con el 8/10 de la VM
   (escenario pesimista, IP de datacenter).
8. `-EnableEngine` (**siempre el ultimo paso**: solo se ejecuta si todo lo
   anterior fue bien): escribe `BROWSER_ENGINE=camoufox` en el `.env` de la
   raiz del repo. Entiende la sintaxis dotenv (`export CLAVE = valor`,
   espacios), conserva el resto de lineas intactas, elimina cualquier
   asignacion previa de `BROWSER_ENGINE` y deja exactamente UNA. La escritura
   es transaccional: temporal + `ReplaceFile` atomico con backup en
   `.env.browserd-bak` (o move simple si el archivo no existia) y verificacion
   post-escritura dentro de la misma transaccion; si CUALQUIER paso falla se
   restaura el estado previo.

Los flags son independientes: `-Start` y `-Bench` se pueden repetir aunque la
instalacion ya este hecha (los pasos 1-5 son idempotentes y rapidos).

## Como lee asistenta el .env

Al arrancar (`npm start` desde la raiz del repo), asistenta carga el `.env`
del directorio de trabajo con `process.loadEnvFile()` de Node (parser propio
de Node: `CLAVE=valor`, `export` opcional, comillas y comentarios). El loader
es `src/envfile.ts`, importado como PRIMER modulo del entrypoint: `paths.ts`
y `log.ts` capturan `process.env` al evaluarse, y cualquier orden que los
alcance antes dejaria la configuracion partida (hay tests que lo fijan:
`test/envfile-*.test.ts`). Las variables ya presentes en el entorno siempre
ganan (verificado contra Node 22.23), y un `.env` mal formado no tira el
arranque: avisa por stderr y sigue con el entorno que haya. **Este script no reinicia asistenta**: el flag se aplica en su proximo
arranque (`npm start`). Hasta entonces el comportamiento no cambia.

## Requisitos

- Windows 10/11 con PowerShell 5.1 (el que trae Windows) y Node ya
  funcionando (asistenta ya corre en este PC; Node >= 22.5 por `node:sqlite`).
- Sin elevacion: todo se instala en la carpeta del usuario.

## Que NO hace

- No reinicia ni para la asistenta que este corriendo.
- No registra arranque automatico del sidecar tras un reinicio de Windows
  (si lo queremos, vendra como tarea del Planificador en otra PR, igual que
  `deploy\windows\install-autostart.ps1`).
- No toca prod ni la VM.

## Problemas frecuentes

- `Python 3.12+ no encontrado`: ver paso 1.
- El sidecar no responde en 30s: revisa `browserd\logs\browserd.err.log`.
- `127.0.0.1:7701 responde pero NO es un browserd valido`: otro proceso ocupa
  el puerto; cierrese antes de seguir.

## Estado de verificacion

Script revisado estaticamente en la VM (sin Windows disponible alli) y smoke
real re-ejecutado contra Camoufox en contenedor (PASS). La primera ejecucion
real del .ps1 es en el PC del usuario: cada paso falla con mensaje claro y el
smoke real (paso 5) es la prueba de que Camoufox funciona en esa maquina
antes de activar nada.
