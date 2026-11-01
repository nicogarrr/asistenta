# /consumo: tokens y coste estimado

`/consumo` en Telegram muestra lo que ha gastado Asistenta en llamadas al modelo, leído de
los ficheros `log/usage-<día>.jsonl` del directorio de estado. Es solo lectura.

- `/consumo` (o `/consumo semana`): hoy, los últimos 7 días (solo los días con consumo) y el
  desglose por modelo.
- `/consumo hoy`, `/consumo mes` (30 días) o `/consumo <1-31>`.
- Alias: `/uso`.

Si `PA_DAILY_BUDGET_EUR` está configurado, muestra el gasto de hoy frente al presupuesto y
marca «superado» con la misma regla que el aviso diario. El coste es una estimación con la
tabla de precios del catálogo o de `PA_PRICE_*` (que solo valen para `PA_MODEL`; un turno con otro modelo elegido con `/modelo` se cobra con la ficha de ese modelo en el catálogo): 0 € no garantiza que el proveedor sea
gratis. Un gasto real menor de un céntimo se muestra como «<0,01 €».
