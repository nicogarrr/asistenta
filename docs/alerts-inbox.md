# Canal de entrada de alertas (CavaAI -> Asistenta)

`POST /alerts/ingest` recibe una alerta firmada y la reenvía como texto plano al chat privado del dueño en Telegram.

## Garantías
- **Una alerta es dato, no una orden.** No pasa por el agente, el modelo ni ninguna tool. Un texto hostil solo puede aparecer como texto en el chat.
- **Fail-closed.** Sin `alerts:token` en el vault el listener no arranca.
- **Sin exponer el PC.** Escucha en `127.0.0.1` por defecto y rechaza cualquier origen que no sea loopback, LAN o tailscale (100.64/10), aunque se haga bind a todas las interfaces.
- **Autenticación HMAC-SHA256**, el secreto no viaja. La firma cubre el cuerpo, caduca a ±5 min y una firma vista no se acepta dos veces.
- Límites: cuerpo ≤ 4 KB, 30 alertas/min, dedupe por `id` 24 h, texto limpiado de caracteres de control y bidi.
- Solo entrega al DM del dueño verificado. Si aún no hay chat del dueño responde `503` y el emisor reintenta (el `id` no se marca como visto).

## Configuración (vault)
| clave | para qué |
|---|---|
| `alerts:token` | secreto compartido (obligatorio, 32+ bytes aleatorios) |
| `alerts:host` | interfaz de escucha, por defecto `127.0.0.1` |
| `alerts:port` | por defecto `8766` |

## Cómo llega CavaAI (VM de Oracle) al PC sin abrirlo a internet
1. **Túnel SSH inverso iniciado desde el PC** (nada entrante): `ssh -N -R 127.0.0.1:8766:127.0.0.1:8766 usuario@vm`. En la VM, CavaAI postea a `http://127.0.0.1:8766`. No hace falta cambiar `alerts:host`.
2. **Tailscale**: poner `alerts:host` a la IP tailscale del PC; CavaAI postea a `http://<ip-tailscale>:8766`.
No hay que abrir puertos en el router en ninguno de los dos.

## Petición
`POST /alerts/ingest`, `Content-Type: application/json`, cabeceras:
- `X-Alert-Ts`: segundos Unix.
- `X-Alert-Nonce`: 8-64 hex aleatorios, único por petición.
- `X-Alert-Sig`: hex de `HMAC-SHA256(token, ts + "." + nonce + ".POST./alerts/ingest." + sha256hex(cuerpo))`.

Cuerpo:
```json
{"id":"pg-down-2026-10-19T00:10","source":"cavaai","severity":"critical","title":"Postgres caído","text":"detalle opcional (≤800)","url":"https://opcional"}
```
`id` (obligatorio, `[\w.:-]`, ≤100), `title` (≤120), `severity` `info|warn|critical` (por defecto `info`), `source` solo `cavaai`.

Respuestas: `202` entregada, `200` duplicada, `400` esquema, `401` firma, `403` origen, `404`/`405`, `413` tamaño, `429` tasa, `503` reintentar.
`GET /alerts/health` responde `200` sin información.

## Ejemplo de cliente (Node)
```js
import { createHash, createHmac, randomBytes } from 'node:crypto';
export async function sendAlert(url, secret, alert) {
  const body = JSON.stringify(alert);
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(8).toString('hex');
  const digest = createHash('sha256').update(body).digest('hex');
  const sig = createHmac('sha256', secret).update(`${ts}.${nonce}.POST./alerts/ingest.${digest}`).digest('hex');
  return fetch(`${url}/alerts/ingest`, { method: 'POST', body,
    headers: { 'content-type': 'application/json', 'x-alert-ts': ts, 'x-alert-nonce': nonce, 'x-alert-sig': sig } });
}
```
Reintentar solo con `503`/red, con el mismo `id` y firma nueva.

## No verificado
Probado con tests contra un servidor real en loopback. No se ha probado la entrega a Telegram real ni el túnel desde la VM de Oracle.
