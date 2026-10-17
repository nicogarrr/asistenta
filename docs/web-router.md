# Enrutador web propio (search + fetch, gratis, con medición)

Idea tomada de [treg](https://github.com/superdesigndev/treg) (Apache 2.0) y hecha en casa, sin depender de terceros, aprobada por Nico el 16-oct-2026: varios backends gratuitos, fallback automático, tope €0 y medición por petición.

## Piezas

- `src/web/router.ts` — el enrutador: eligibilidad por operación, tope de coste fail-closed, fallback por orden y métricas JSONL.
- `src/web/backends.ts` — los backends gratuitos:
  - `directo`: la lectura directa de siempre (misma puerta SSRF que la tool `fetch`). Sin clave ni límites. Coste 0 €.
  - `tinyfish`: Search + Fetch API de TinyFish. **Gratis siempre** (no descuentan del wallet; fuentes abajo). Requiere clave en el vault; sin clave no se registra.
  - `ddg`: búsqueda HTML de DuckDuckGo, sin clave. Último fallback de búsqueda.
- `src/tools/web.ts` — la tool `web` del agente (acciones `search`, `fetch`, `stats`).
- `scripts/bench-web.mjs` — benchmark real por backend → `docs/web-router-bench.md`.

## Tope €0 (la regla dura)

Cada backend declara su coste por llamada. Antes de llamar, el router comprueba `coste ≤ PA_WEB_MAX_COST_EUR` (por defecto **0**). Un coste inválido (NaN, negativo, infinito) cierra el paso igualmente. Si no queda ningún backend dentro del tope, la petición falla en claro diciendo que nunca se cobra. Un backend de pago simplemente no se llega a llamar nunca.

## Medición

Cada intento (éxito o fallo) añade una línea a `<state>/log/web-metrics.jsonl`: operación, backend, ok, latencia, chars, tokens estimados (chars/4) y coste. **Nunca** guarda la query, la URL completa (solo el host) ni claves. `web stats` agrega por backend: llamadas, % ok, p50/p95, chars/tokens y coste total.

## Activar TinyFish (opcional)

```
pa vault set web:tinyfishApiKey
```

Con clave: `search` prueba TinyFish antes que ddg; `fetch` gana un fallback detrás de `directo` para páginas con anti-bot (el caso que hoy devuelve 403/202). Sin clave todo sigue funcionando con `directo` + `ddg`.

## Fuentes (17-oct-2026)

- Search y Fetch gratis siempre, sin tocar el wallet: <https://www.tinyfish.ai/pricing> y <https://docs.tinyfish.ai/search-api/index.md>
- Cuenta sin tarjeta ($8 de wallet inicial, auto-reload off): verificado en el alta real, 17-oct-2026.
- Límites exactos del gratuito: no publicados en docs; un 429/402 cae al siguiente backend o falla en claro (nunca cobra).
- API: `GET https://api.search.tinyfish.ai`, `POST https://api.fetch.tinyfish.ai`, cabecera `X-API-Key` (<https://docs.tinyfish.ai/authentication>).
