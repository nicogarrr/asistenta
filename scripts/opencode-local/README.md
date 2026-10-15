# opencode-local: asistenta sobre el free tier de OpenCode Zen

El free tier de Zen solo acepta llamadas que salen del cliente real de
OpenCode (403 FreeTierError por API directa, medido el 2026-10-15). La via
legitima: `opencode serve` corriendo en el propio PC y asistenta apuntando
a el (preset `opencode-local`, ver `src/core/opencode-local.ts`).

## Puesta en marcha en Windows (una vez)

1. Instalar el cliente: `npm i -g opencode-ai`
2. Conectar la cuenta de Zen: `opencode auth login` y elegir OpenCode Zen
   con la API key (la misma que asistenta ya guarda como `provider:apiKey`).
   Esto escribe `%USERPROFILE%\.local\share\opencode\auth.json`.
3. Crear una carpeta para el servidor, p.ej. `%USERPROFILE%\opencode-serve`,
   y copiar dentro el `opencode.json` de esta carpeta (agente `asistenta`
   con prompt minimal y `small_model` apuntando a un modelo free: sin eso
   el cliente hace side-calls de pago para titulos que fallan sin fondos).
4. Arrancar el servidor desde ESA carpeta:
   `opencode serve --hostname 127.0.0.1 --port 4096`
   (para autostart seguir el mismo patron que browserd: tarea programada
   de Windows al iniciar sesion).
5. En el `.env` de asistenta:
   ```
   PA_PROVIDER_PRESET=opencode-local
   ```
   (opcional: `PA_BASE_URL=http://127.0.0.1:4096`, `PA_MODEL=deepseek-v4.1-flash-free`)
6. Reiniciar asistenta. Para volver atras: quitar el preset del `.env`.

## Limites honestos (medidos)

- Los modelos -free rechazan custom tools de opencode: las tools de
  asistenta viajan en el prompt y el modelo pide la llamada en JSON. Si el
  modelo se desvia del formato, la respuesta llega como texto (nunca se
  ejecuta una llamada inventada).
- v1 no hace streaming token a token: la respuesta llega entera.
- El free tier es gratis pero con limites de Zen por cuenta; si se agota,
  el error llega como `error` del stream y asistenta lo reporta.
