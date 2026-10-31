# REA para el equipo: estudiar cómo hacen las cosas otras apps

[REA](https://github.com/morluto/rea) (MIT) sirve también fuera de Asistenta, para preparar carriles nuevos.

- **Para qué:** ver cómo resuelve una función otro asistente o app (por ejemplo, cómo guarda la memoria una app de escritorio Electron o qué llamadas hace una web) antes de diseñar la nuestra.
- **Cómo:** `npx -y rea-agents@latest analyze-javascript-application /ruta/absoluta/a/la/app --json` (o el servidor MCP con `npx -y rea-agents mcp`). Para programas nativos, con Ghidra instalado.
- **Qué traer:** un resumen corto en NOTES.md del carril: qué hace la app, qué pruebas lo muestran (ficheros, funciones, llamadas) y qué no está claro. Copiar ideas, no código ajeno con licencia que no lo permita.
- **Límites:** solo apps públicas o nuestras, solo lectura. Nada de saltarse licencias, DRM ni protecciones. Nunca con cuentas o datos reales de Nico.
