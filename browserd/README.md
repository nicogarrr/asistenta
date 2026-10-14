# browserd - sidecar de navegador anti-deteccion (Camoufox)

Proceso Python local que mantiene sesiones de navegador con huella de Firefox
real ([Camoufox](https://github.com/daijro/camoufox), MPL-2.0) y expone una
API HTTP minima en `127.0.0.1:7701`. El servicio de navegador de asistenta
(Node, `src/browser/service.ts`) lo usará como motor alternativo al actual
(playwright + Chrome) cuando una tienda devuelve challenges o bloqueos.

Por que: en el benchmark de 2026-10-14 (10 objetivos reales, VM ARM64 con IP
de datacenter - escenario pesimista; `ok` exige 2xx + contenido real),
Camoufox abrio 8/10 sin un solo challenge frente a 3/10 del stack actual, con
algo de varianza entre corridas (Fnac oscilo ok/403). La validacion definitiva
se hace en el PC del usuario con su IP residencial con `bench/bench_camoufox.py`.

## Requisitos

- Python 3.12+ (Windows: python.org, marcando "Add to PATH")
- `pip install -r requirements.txt`
- `python -m camoufox fetch` (descarga el Firefox parcheado, una vez)

## Arranque

```
python -m browserd            # 127.0.0.1:7701, perfiles en ./profiles
```

Variables: `BROWSERD_HOST` (fuera de loopback EXIGE `BROWSERD_TOKEN` o el
arranque falla), `BROWSERD_PORT`, `BROWSERD_PROFILES_DIR`,
`BROWSERD_MAX_SESSIONS` (4), `BROWSERD_TOKEN` (bearer; en localhost puede
quedar vacio), `BROWSERD_VISIBLE=1` (ventana, para depurar),
`BROWSERD_EVAL_TIMEOUT_MS` (30000).

Defensas: toda ruta rechaza Host ajeno a loopback (anti DNS-rebinding) y
Origin ajeno; goto/evaluate van serializados por sesion y con timeout.

## API (todas JSON)

- `GET /health` - estado y sesiones activas (sin auth)
- `POST /sessions` `{scope}` - crea/reusa sesion con perfil persistente por scope
- `GET /sessions` - lista
- `DELETE /sessions/{id}` - cierra
- `POST /sessions/{id}/goto` `{url, wait_until, timeout_ms, settle_ms}` -> `{status, url, title}`
- `POST /sessions/{id}/evaluate` `{expression}` -> `{value}`

## Bateria anti-bot de un comando (validacion en el PC)

```
python bench/bench_camoufox.py
```

Recorre `bench/targets.json` (7 tiendas + Google + pagina-test de Cloudflare +
Amazon) y deja el resultado en `bench/results.json`. `ok` exige pagina valida
(2xx + contenido minimo); un 200 vacio o un error HTTP no cuentan. Usa un
perfil persistente propio (`bench/profile`). Sirve para comparar la IP
residencial del PC con los numeros de la VM antes de activar el sidecar en
produccion.

## Tests

```
pip install pytest httpx
python -m pytest tests/
```

Los tests usan engines falsos: no levantan navegadores de verdad.

## Limites declarados

- Sin proxy rotation ni resolucion de captchas: si una tienda planta un
  captcha interactivo, asistenta lo trata como hoy (handoff al usuario).
- Cada sesion mantiene un Firefox en memoria (~300-500 MB); por eso el limite
  por defecto es 4.
- El adapter Node (src/browser/service.ts -> este servicio, con fallback al
  motor actual por flag) llega en una PR posterior.

## Integracion con pricewatch (BROWSER_ENGINE)

`src/watch/pricewatch-browserd.ts` enruta las lecturas publicas de tienda por
el sidecar cuando `BROWSER_ENGINE=camoufox` (cualquier otro valor o ausencia =
motor actual playwright, comportamiento historico). Variables: `BROWSERD_URL`
(defecto `http://127.0.0.1:7701`) y `BROWSERD_TOKEN` (bearer; vacio en
loopback). Si el sidecar no responde, el primer fallo de transporte conmuta al
motor playwright para el resto del ciclo (se registra una vez); un 403 de
bloqueo/challenge NO dispara fallback. Limitacion: el `permit` (robots/presu-
puesto) se aplica solo al documento principal, sin interception por subrecurso.
