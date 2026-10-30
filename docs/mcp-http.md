# MCP por HTTP (Streamable HTTP)

Apagado por defecto. Con `PA_MCP_HTTP=1`, las entradas de `PA_MCP_SERVERS` que llevan
`url` en vez de `command` se usan como servidores MCP remotos:

```json
[{ "name": "remoto", "url": "https://mcp.ejemplo.com/mcp", "allowedTools": ["buscar"] }]
```

- Solo `https://`, o `http://` hacia el propio equipo (`localhost`, `127.x`, `[::1]`). Cualquier
  otra URL se descarta con un aviso. No se siguen redirecciones.
- Token: si el servidor pide autorización, guárdalo en el almacén privado como
  `mcp:<nombre>:token` (se envía como `Authorization: Bearer …`). Nunca va en la
  configuración ni sale en los logs.
- 401/403 al arrancar: el servidor se omite con un aviso y los demás siguen.
- Respuestas en JSON o `text/event-stream`; la cabecera `Mcp-Session-Id` se reenvía.
- `timeoutMs` por servidor (30 s por defecto) y tope de 4 MB por respuesta.
- Sus tools se publican igual que las de stdio (`mcp_<servidor>_<tool>`).

Sin `PA_MCP_HTTP=1` nada cambia: las entradas con `url` se ignoran como hasta ahora.

## Comprobarlo con `pa doctor`

`pa doctor` muestra una línea `mcp http` con el estado del transporte (apagado o activado) y, por cada entrada con `url` de `PA_MCP_SERVERS`, si está configurada (solo el origen de la URL y si el token `mcp:<nombre>:token` está guardado, nunca su valor) u omitida y por qué (transporte apagado, URL no permitida, nombre no válido o repetido). No conecta con ningún servidor.

## Recursos y prompts

Además de las tools, el cliente HTTP habla `resources/list`, `resources/read`, `prompts/list` y `prompts/get` con la misma forma que el cliente stdio (mismas comprobaciones y mensajes de error). Sigue apagado por defecto: solo se usa con `PA_MCP_HTTP=1`.
