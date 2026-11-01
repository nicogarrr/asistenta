# Enrutador web propio (search + fetch, gratis, con medición)

Idea tomada de [treg](https://github.com/superdesigndev/treg) (licencia Apache 2.0) reimplementada en propio, sin depender de ese servicio: varios backends declarados gratuitos, fallback automático, tope de coste y medición por petición.

## Piezas

- `src/web/router.ts` — el enrutador: eligibilidad por operación, tope de coste fail-closed, fallback por orden y métricas JSONL.
- `src/web/backends.ts` — los backends gratuitos:
  - `directo`: la lectura directa de siempre (misma puerta SSRF que la tool `fetch`). Sin clave ni límites. Coste 0 €.
  - `tinyfish`: Search + Fetch API de TinyFish. **Gratis siempre** (no descuentan del wallet; fuentes abajo). Requiere clave en el vault; sin clave no se registra.
  - `ddg`: búsqueda HTML de DuckDuckGo, sin clave. Último fallback de búsqueda.
- `src/tools/web.ts` — la tool `web` del agente (acciones `search`, `fetch`, `stats`).
- `scripts/bench-web.mjs` — benchmark real por backend → `docs/web-router-bench.md`.

## Tope de coste (qué garantiza y qué no)

Cada backend declara su coste por llamada en código. Antes de llamar, el router comprueba `coste declarado ≤ PA_WEB_MAX_COST_EUR` (por defecto **0**). Un coste inválido (NaN, negativo, infinito) cierra el paso igualmente. Si no queda ningún backend dentro del tope, la petición falla en claro y no se llama a nada.

**Garantiza**: un backend declarado por encima del tope no se llama nunca.
**No garantiza**: la protección es *declarativa* — el router no consulta el precio real del proveedor en cada llamada. Si un proveedor gratis pasa a cobrar, hay que actualizar la declaración en `src/web/backends.ts`. Las declaraciones actuales se verificaron contra fuentes públicas el 17-oct-2026 (sección Fuentes).

## Medición

Cada intento (éxito o fallo) añade una línea a `<state>/log/web-metrics.jsonl`: operación, backend, ok, latencia, chars, tokens estimados (chars/4) y coste. **Nunca** guarda la query, la URL completa (solo el host) ni claves. `web stats` agrega por backend: llamadas, % ok, p50/p95, chars/tokens y coste total.

## Activar TinyFish (opcional)

```
pa vault set-stdin web:tinyfishApiKey
```

Con clave: `search` prueba TinyFish antes que ddg; `fetch` gana un fallback detrás de `directo` para páginas con anti-bot (el caso que hoy devuelve 403/202). Sin clave todo sigue funcionando con `directo` + `ddg`.

## Fuentes (17-oct-2026)

- Search y Fetch gratis con cualquier saldo de wallet: <https://www.tinyfish.ai/pricing> ("Search and Fetch free at any Wallet balance") y <https://docs.tinyfish.ai/search-api/index.md> ("Search never draws from your wallet — it's free at any balance, including $0"), ambas consultadas el 17-oct-2026.
- Alta sin tarjeta: la propia página de registro declara "$8 free in your wallet — no credit card required" (<https://agent.tinyfish.ai/sign-up>, 17-oct-2026).
- Límites exactos del gratuito: no publicados en la documentación; un 429/402 cae al siguiente backend dentro del tope o falla en claro.
- API: `GET https://api.search.tinyfish.ai`, `POST https://api.fetch.tinyfish.ai`, cabecera `X-API-Key` (<https://docs.tinyfish.ai/authentication>, 17-oct-2026).

## Notas de seguridad

- La clave TinyFish viaja solo en la cabecera `X-API-Key` y **nunca sigue redirects**: las llamadas van con `redirect: 'manual'` porque Node no quita cabeceras personalizadas en redirects cross-origin, y un 302/307 de la API la reenviaría a otro host (hay un canario en `test/web-router.test.ts`).
- Puerta SSRF en tres capas: la tool `web`, `WebRouter.routeFetch` y el propio backend remoto validan la URL inicial con la misma función que la tool `fetch`. Límite declarado: los redirects que ocurran en el lado del proveedor los valida él (`invalid_url` / `invalid_redirect_url` en su API), no nosotros.
