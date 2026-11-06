# Puerta de contenido externo (taint)

Cuando en una conversación Asistenta lee contenido que no escribiste tú (búsqueda web, `fetch`
de una página, el navegador, una descarga, un documento, OCR o una herramienta MCP), esa
conversación queda **marcada**. Mientras lo esté, cualquier acción que no sea de solo lectura
deja de estar cubierta por permisos guardados («siempre», «por ahora», la ventana tras
aprobar, lo ya aprobado en la sesión o el control total) y te pide aprobación expresa, con el
motivo «Tras leer contenido externo (página ejemplo.com)…». Así, un texto malicioso de una
web no puede aprovechar un permiso que diste antes para enviar, pagar o ejecutar algo.

- Las lecturas siguen sin preguntar; las reglas de la lista de permitidos siguen valiendo.
- La marca se limpia con tu siguiente mensaje y caduca sola a los 30 minutos.
- `PA_TAINT_GATE=off` la desactiva. Solo endurece: nunca permite algo que antes se preguntaba.
- Límite conocido: las acciones del propio navegador cuentan como lectura de la página y no se
  marcan entre sí; siguen pasando por sus aprobaciones de compra y credenciales.

## Órdenes de shell: `PA_APROBAR_SIEMPRE` y el botón «Siempre»

- `PA_APROBAR_SIEMPRE` (activo por defecto): en tu chat privado con Asistenta, una orden de
  shell de **solo lectura** (procesos, ficheros, red, `git status`, versiones) o el
  mantenimiento de la propia Asistenta (`git pull`, `npm run build`, `pa doctor`) corre sin
  preguntar. Nunca en grupos, y nunca con la conversación marcada por contenido externo.
  `PA_APROBAR_SIEMPRE=0` (o `off`, `no`, `false`) vuelve a preguntar por todo.
- Una orden **no arriesgada** que sí pregunta ofrece «Una vez», «Por ahora», «Siempre» y
  «Denegar». «Siempre» vale para esa clase de órdenes (`shell-seguro`) y se quita con
  `/permisos revocar shell-seguro`.
- Una orden **arriesgada** (borra, instala, sube privilegios o lleva código en línea) solo
  ofrece «Permitir» y «Denegar»: pregunta cada vez y no admite permisos guardados, así que
  «Siempre» y «Por ahora» ya no aparecen.
