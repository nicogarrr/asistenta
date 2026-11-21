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

Quedan fuera, a propósito: `report_application` (cuenta candidaturas a la web),
`hiring_contact` (contactos de personas), `application_guide` (instrucciones
para el agente, no un dato) y `job_questions`. Además `readOnlyOnly` bloquea cualquier tool que el
servidor no declare de solo lectura, aunque se añada en el futuro.

**Las candidaturas no se envían solas.** Estas tools solo leen. Aplicar a una
oferta lo haces tú, o Asistenta paso a paso y con tu sí en cada envío.

## Salidas de red y datos remotos

- `job_questions` **no se publica**: leería en vivo formularios y páginas de
  tableros externos (Greenhouse, Lever, Workday, webs de empleo de cada
  empresa…), y el destino lo decide el índice remoto `jobs.json`. Si se
  volviera a publicar, esas consultas externas pasarían a ser parte de lo que
  hace Asistenta. El código vendado ya exige HTTPS, sin puerto, sin IP ni
  nombres locales, lista de tableros conocidos y sin redirecciones, pero no
  comprueba a qué IP resuelve el DNS: eso falta antes de reactivarla.
- Los datos remotos (`data.json`) no llegan al modelo como texto de
  descripciones: `min_group`, `quartile_min` y los tramos de tamaño se validan
  por tipo y rango (y si no encajan, se usa un valor fijo).
- La descarga de datos (`scripts/mcp-stdio.mjs`) solo acepta HTTPS, con
  tiempo máximo de 15 s, tope de 20 MB, comprobación de estado HTTP y sin
  seguir redirecciones.
- `find_jobs` y las demás tools devuelven datos del índice remoto como
  resultado (títulos, empresas, enlaces): son datos no fiables, no
  instrucciones, y no se abre ningún enlace sin que lo pidas.

## Privacidad

- El servidor corre en tu PC; las consultas no salen: solo se descargan los
  datos públicos (`data.json` al arrancar; `jobs.json` y `company-cells.json`
  la primera vez que hacen falta; sin formularios externos en vivo mientras
  `job_questions` siga sin publicarse) de spanishtoptechcompanies.com.
- La telemetría PostHog del código original solo se activa en el despliegue del
  autor; aquí no envía nada.
- El proceso hijo no hereda tus claves: solo rutas, temporales e idioma
  (`envAllowlist`).

## Actualizar el servidor vendado

1. Revisar el diff completo en el repo original desde el commit anclado.
2. Copiar los mismos archivos a `vendor/tech-pay-spain/`.
3. Subir el commit en `vendor/tech-pay-spain/README.md` y `THIRD_PARTY_NOTICES.md`.
4. Correr `test/empleo-mcp.test.ts`.
