# Deploy del sidecar browserd en el PC (Windows)

Un comando instala y valida el sidecar Camoufox en este PC:

```powershell
git pull
powershell -ExecutionPolicy Bypass -File deploy\browserd\setup-browserd.ps1 -Start -Bench -EnableEngine
```

Que hace, en orden:

1. Localiza Python 3.12+ (`py -3.12` o `python`). Si no esta, avisa y para:
   instalalo desde [python.org](https://www.python.org) marcando
   "Add python.exe to PATH" y repite el comando.
2. Crea el entorno virtual `browserd\.venv` (no toca ningun otro Python).
3. `pip install -r browserd\requirements.txt`.
4. `python -m camoufox fetch` (descarga el Firefox parcheado; solo la
   primera vez).
5. Smoke real: levanta Camoufox con la barrera de red contra un servidor
   loopback (redirect + subrecurso) y exige PASS.
6. `-Start`: arranca el sidecar en segundo plano (`127.0.0.1:7701`, logs en
   `browserd\logs`, sobrescritos en cada arranque). Si ya hay uno
   respondiendo, no arranca otro.
7. `-Bench`: bateria anti-bot real (`browserd\bench\results.json`) con la IP
   residencial de este PC - la cifra que compara con el 8/10 de la VM
   (escenario pesimista, IP de datacenter).
8. `-EnableEngine`: escribe `BROWSER_ENGINE=camoufox` en `.env`. **No
   reinicia asistenta**: el flag se aplica en su proximo reinicio natural
   (`npm start`). Hasta entonces el comportamiento no cambia.

Los flags son independientes: `-Start` y `-Bench` se pueden repetir aunque la
instalacion ya este hecha (los pasos 1-5 son idempotentes y rapidos).

## Requisitos

- Windows 10/11 con PowerShell 5.1 (el que trae Windows) y Node ya
  funcionando (asistenta ya corre en este PC).
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
- Puerto 7701 ocupado por otra cosa: el script lo detecta como "ya hay un
  browserd"; comprueba con `Invoke-RestMethod http://127.0.0.1:7701/health`.

## Estado de verificacion

Script revisado estaticamente en la VM (sin Windows disponible alli). La
primera ejecucion real es en el PC del usuario: cada paso falla con mensaje
claro y el smoke real (paso 5) es la prueba de que Camoufox funciona en esa
maquina antes de activar nada.
