# Daemon real por el canal de QA (humo de punta a punta)

`npm run build && npm run qa:daemon` arranca el daemon de verdad (`dist/cli.js serve`), no una
composición de piezas: mismo `serveCommand`, mismo router de comandos, mismo Gate y mismas
herramientas. Todo es local y falso:

- `PA_QA_CHANNEL=1` con un `PA_STATE_DIR` temporal (con el marcador `qa/SANDBOX`): los mensajes
  entran por `qa/inbox.jsonl` y salen a `qa/outbox.jsonl` (texto, aprobaciones, errores).
- Vault portable con secretos falsos por entorno (`PA_SECRET_*`).
- `scripts/qa-daemon/preload.mjs` deja grammy sin red: nada habla con api.telegram.org.
- `scripts/qa-daemon/fakellm.mjs` es un modelo falso (API de chat completions) que sigue un guion
  de pasos `{text}` / `{tool, args}`.

`scripts/qa-daemon/smoke.sh` comprueba: un recordatorio se programa y queda en `agent.db`, `/help`
contesta, la puerta de exfiltración pregunta con la URL completa tras leer un archivo, y `/resumen
hoy` y `/correo` se niegan fuera del DM del dueño. Para un escenario propio:
`bash scripts/qa-daemon/run.sh <dir> <guion.json> <inbox.jsonl> [segundos]` y leer el outbox.

Nunca en Windows (el canal de QA se niega a arrancar allí) y nunca con secretos reales.
