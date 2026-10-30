# Vigilar precios desde el chat

Además de `/vigila <enlace> objetivo=400€`, el agente tiene la herramienta `vigilar_precio`: basta con decir
«avísame si el portátil de este enlace baja de 400 €». Crea la vigilancia en el mismo registro que `/vigila`
(se ve en `/vigilando`, `/precio <id>` y se quita con `/dejar_de_vigilar <id>`), y las lecturas las hace el bucle
de vigilancia cada ~2 h **sin gastar modelo**.

- Acciones: `add` (url + `target_eur`, `drop_pct`, `keyword`, `label` opcionales), `list`, `remove` (id).
- Solo enlaces públicos http(s) (mismo control SSRF que `fetch`); máximo 10 por chat.
- Crear una vigilancia cuenta como salida a la red: tras leer algo privado en el turno, una URL con datos a un
  dominio nuevo pide permiso igual que un `fetch` (puerta de exfiltración, `src/egress-taint.ts`).
