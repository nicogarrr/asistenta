# tech-pay-spain (vendor)

Servidor MCP de <https://github.com/pugarte7/spanish-top-tech-companies>
(salarios tech en España y ofertas abiertas), copiado tal cual tras revisar el
código, para que lo que corre en el PC sea exactamente lo revisado.

- Commit anclado: `21d72c4c3d4a3fd581bf5f14217dcf6d972c5c79` (2026-11-21).
- Licencia: MIT (Pablo Ugarte), en `LICENSE` y en `THIRD_PARTY_NOTICES.md`.
- Archivos: `scripts/mcp-stdio.mjs` (entrada stdio) y `api/mcp.js`,
  `api/_classify.js`, `api/_track.js` (sus únicas dependencias internas). Sin
  dependencias npm; Node 22 o posterior.
- Los datos los lee en vivo de la web (`data.json` al arrancar; `jobs.json` y
  `company-cells.json` en la primera tool que los necesita). No usa claves ni
  variables de entorno.
- La telemetría PostHog de `api/_track.js` solo se activa con
  `VERCEL_ENV=production` (su despliegue); aquí nunca envía nada.

Para actualizarlo: revisar el diff completo en el repo original, copiar los
mismos archivos, subir el commit en este README y en `THIRD_PARTY_NOTICES.md`,
y correr `test/empleo-mcp.test.ts`.
