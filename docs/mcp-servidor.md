# Asistenta como servidor MCP (solo lectura)

`pa mcp serve` arranca un servidor MCP por stdio para que otras herramientas (Claude Desktop/Code, Cursor, Codex…) consulten a Asistenta. Solo arranca si lo ejecutas tú; el daemon no lo abre.

Tools (todas de solo lectura, sobre el chat privado del dueño):
- `memoria_buscar { consulta, limite? }`
- `sesiones_buscar { consulta, limite? }`
- `objetivos_listar {}`
- `agenda_hoy {}`: seguimientos pendientes de hoy (y los vencidos sin cerrar) y rutinas programadas que tocan hoy, en la hora de `PA_TIMEZONE`. No lee el calendario remoto.

No hay ninguna tool que escriba. Todo lo que sale pasa por el mismo filtro de secretos que el registro (`--password=…`, tokens, `sk-…`).

Ejemplo de configuración en el cliente:

```json
{ "mcpServers": { "asistenta": { "command": "pa", "args": ["mcp", "serve"] } } }
```

Si no sabe cuál es el chat del dueño (más de un usuario permitido y sin `vigilante:ownerUserId`), sale con código 1 y lo explica.
