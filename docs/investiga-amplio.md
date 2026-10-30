# Investigación amplia en paralelo (`/investiga amplio`)

Apagada por defecto. `PA_INVESTIGA_AMPLIO=1` la activa (hace una consulta al modelo por elemento).

```
/investiga amplio precio y garantía | iPhone 16, Pixel 9, Galaxy S25
```

- Una fila por elemento (máx. 10), en el orden de la lista; la lista puede ir separada por comas, `;` o líneas.
- Como mucho 3 elementos a la vez y un presupuesto compartido (4 operaciones por elemento: búsqueda, 2 lecturas, modelo). Si se agota, las filas que faltan dicen «sin datos (presupuesto agotado)» y el informe lo avisa.
- Cada celda lleva su cita `[n]` a una fuente leída; un elemento que falla queda «sin datos» sin parar el resto.
- Web gratis: usa el mismo enrutador que `/investiga` (tope `PA_WEB_MAX_COST_EUR`, 0 € por defecto). Sin modelo, la celda es una cita textual.
- Salida: tabla Markdown + fuentes. `wideReportCsv()` da la misma tabla en CSV.

En Telegram, tras el informe llega la misma tabla como `investigacion-<pregunta>.csv` (UTF-8 con BOM, para que Excel respete las tildes). Si el adjunto falla, el informe en texto ya está enviado.
