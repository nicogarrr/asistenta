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

### Que el asistente los use (`PA_MCP_RESOURCES=1`)

Apagado por defecto. Con `PA_MCP_RESOURCES=1`, cada servidor MCP (stdio o HTTP) que responda al listado publica dos herramientas de solo lectura:

- `mcp_<servidor>_leer_recurso`: sin `uri` lista los recursos; con `uri` lee uno. Solo acepta URIs que el propio servidor anuncia en `resources/list`.
- `mcp_<servidor>_usar_prompt`: sin `nombre` lista los prompts; con `nombre` (y `argumentos`) devuelve su texto. Comprueba los argumentos obligatorios.

Si el servidor tiene `allowedTools`, hay que añadir `"@recursos"` y/o `"@prompts"` a la lista para publicarlas. Lo que devuelven cuenta como contenido externo (como cualquier tool `mcp_*`), y el texto se recorta a 20 000 caracteres.

`pa doctor` muestra la línea `mcp recursos`: apagado, o activado con, por servidor en uso, qué herramientas (`mcp_<servidor>_leer_recurso` / `mcp_<servidor>_usar_prompt`) publicaría si el servidor los lista según `allowedTools`. No conecta con ningún servidor ni muestra URLs.

### Plantillas de recursos (opcional)

Con `PA_MCP_RESOURCES=1` y además `PA_MCP_RESOURCE_TEMPLATES=1` (apagado por defecto), `mcp_<servidor>_leer_recurso` lista también las plantillas que anuncia el servidor (`resources/templates/list`) y acepta `plantilla` + `valores`. Solo se usan plantillas anunciadas y solo de la forma `{nombre}` (RFC 6570 nivel 1); cada valor se codifica entero (también `/`, `?` y `#`), `.` y `..` se rechazan, así que el modelo no puede salirse del hueco de la plantilla.
