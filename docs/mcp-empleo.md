# MCP de empleo tech en España

Asistenta lleva integrado el servidor MCP de
[spanish-top-tech-companies](https://github.com/pugarte7/spanish-top-tech-companies):
sueldos tech en España por rol, región y empresa, y ofertas de empleo abiertas
(actualizadas a diario). Coste: 0 €, sin claves ni registro.

Va **encendido por defecto**; `PA_EMPLEO=0` lo apaga. No hay nada que instalar:
el servidor va vendado en `vendor/tech-pay-spain/` (código revisado y commit
anclado, ver `THIRD_PARTY_NOTICES.md`) y Asistenta lo arranca por stdio con el
mismo Node del daemon.

## Qué tools ve el modelo

Solo las de lectura, como `mcp_empleo_<tool>`:

- `list_filters`: roles, regiones y tramos de experiencia válidos.
- `salary_stats`: qué paga un rol en España (mediana, p25-p75, % sobre 60k).
- `top_companies`: empresas que más pagan para una selección.
- `company_salaries`: sueldos de una empresa.
- `find_jobs`: ofertas abiertas, con filtros (texto, rol, región, remoto, sueldo mínimo…).
- `job_questions`: el formulario de aplicación de una oferta, leído en vivo de su tablero.

Quedan fuera, a propósito: `report_application` (cuenta candidaturas a la web),
`hiring_contact` (contactos de personas) y `application_guide` (instrucciones
para el agente, no un dato). Además `readOnlyOnly` bloquea cualquier tool que el
servidor no declare de solo lectura, aunque se añada en el futuro.

**Las candidaturas no se envían solas.** Estas tools solo leen. Aplicar a una
oferta lo haces tú, o Asistenta paso a paso y con tu sí en cada envío.

## Privacidad

- El servidor corre en tu PC; las consultas no salen: solo se descargan los
  datos públicos (`data.json` al arrancar; `jobs.json` y `company-cells.json`
  la primera vez que hacen falta) de spanishtoptechcompanies.com.
- La telemetría PostHog del código original solo se activa en el despliegue del
  autor; aquí no envía nada.
- El proceso hijo no hereda tus claves: solo rutas, temporales e idioma
  (`envAllowlist`).

## Actualizar el servidor vendado

1. Revisar el diff completo en el repo original desde el commit anclado.
2. Copiar los mismos archivos a `vendor/tech-pay-spain/`.
3. Subir el commit en `vendor/tech-pay-spain/README.md` y `THIRD_PARTY_NOTICES.md`.
4. Correr `test/empleo-mcp.test.ts`.
