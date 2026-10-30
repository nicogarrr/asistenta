# Puerta de contenido externo (taint)

Cuando en una conversación Asistenta lee contenido que no escribiste tú (búsqueda web, `fetch`
de una página, el navegador, una descarga, un documento, OCR o una herramienta MCP), esa
conversación queda **marcada**. Mientras lo esté, cualquier acción que no sea de solo lectura
deja de estar cubierta por permisos guardados («siempre», «esta sesión», la ventana tras
aprobar, lo ya aprobado en la sesión o el control total) y te pide aprobación expresa, con el
motivo «Tras leer contenido externo (página ejemplo.com)…». Así, un texto malicioso de una
web no puede aprovechar un permiso que diste antes para enviar, pagar o ejecutar algo.

- Las lecturas siguen sin preguntar; las reglas de la lista de permitidos siguen valiendo.
- La marca se limpia con tu siguiente mensaje y caduca sola a los 30 minutos.
- `PA_TAINT_GATE=off` la desactiva. Solo endurece: nunca permite algo que antes se preguntaba.
- Límite conocido: las acciones del propio navegador cuentan como lectura de la página y no se
  marcan entre sí; siguen pasando por sus aprobaciones de compra y credenciales.
