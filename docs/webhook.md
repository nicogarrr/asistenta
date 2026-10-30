# Webhook local (`PA_WEBHOOK_PORT`)

Lanza una rutina programada desde otro programa de tu PC (un script, Home Assistant, un atajo):

```
curl -X POST -H "Authorization: Bearer $PA_WEBHOOK_TOKEN" http://127.0.0.1:8787/hook/resumen
```

- Apagado por defecto. Se enciende con `PA_WEBHOOK_PORT` y `PA_WEBHOOK_TOKEN` (≥ 24 caracteres).
- Solo escucha en 127.0.0.1 y rechaza otra cabecera Host (protección contra DNS rebinding).
- `PA_WEBHOOK_ROUTINES=resumen,luces` limita qué rutinas se pueden lanzar; `PA_WEBHOOK_PER_MINUTE` (10) limita las peticiones, también las fallidas.
- El cuerpo de la petición se ignora: la rutina corre con su prompt y con sus permisos y aprobaciones de siempre, igual que `/cron probar`.
- Respuestas: 202 lanzada · 401 token · 403 no permitida · 404 no existe · 409 en pausa/ya en marcha · 429 límite.
