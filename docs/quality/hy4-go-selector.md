# Hy4 Flash por Go: seleccion explicita, sin activacion de produccion

Panel Estado: nueva opcion `hy4-flash-free`. Persiste PA_MODEL y recarga la
config viva como las opciones existentes. Default sin cambios. No migra .env
ni selecciona Hy4 automaticamente.

createProviderHandle detecta el modelo exacto, fija el endpoint Go actual,
y elimina fallbackModel/fallbackModels/extraModels/fastModel/utilityModel y
rotacion extra de claves para ese handle. Usa la clave existente del vault
local `provider:apiKey` o el mecanismo Go ya existente. No almacena secretos.

El fetch exclusivo consulta catalogo antes de cada inferencia, exige precio
cero numerico y endpoint exacto. JSON y SSE se retienen por completo hasta
validar usage.cost=0, model exacto y usage.opencode (billing_source=go,
list_cost=0, allowance=0). SSE fuerza include_usage=true. No salen textos ni
tool calls antes de validar facturacion. Esto sacrifica streaming incremental.
Maximo una peticion en vuelo por proceso, sin cola; latch compartido por
handles del proceso ante fallo. Sin persistencia de latch entre reinicios.

LIMITES: no existe garantia de cero absoluto ante cambio de precio entre
catalogo e inferencia. No verifica ExtraUsage/PAYG OFF de la cuenta. El endpoint
real /zen/go/v1/usage solo devolvio ventanas de cuota, sin esa configuracion;
no hay endpoint documentado localizado para leer el flag. Por ello esta rama
NO debe activarse ni fusionarse como garantia de 0 EUR hasta cerrar ese gate.
La clave solo se uso fuera de esta PR para lectura autorizada de cuota.

Tests locales focalizados del guard, selector y wiring: 28 verdes, guard
100% lineas y >=85% ramas. Biome de ficheros cambiados verde, tsc del guard
estricto verde. Typecheck completo: primer intento OOM con heap default;
reintentos a 3 GB superaron 105 segundos sin resultado. No afirmar CI verde.
No se ha probado el flujo en el PC Windows ni activado el modelo alli.
La UI existente reutiliza selector, sin cambio de layout; preview visual no
realizado, pendiente antes de cerrar el trabajo visual.
