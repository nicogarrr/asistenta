# Benchmark enrutador web — 2026-10-17 (real, no simulado)

Clave TinyFish: NO — pata TinyFish sin medir. Entorno: CI/sandbox Linux, red saliente estandar. chars = texto entregado tras el truncado de 20k de la lectura; latencia = mediana estadistica.

| op | backend | llamadas | ok | latencia mediana (ms) | chars entregados medios |
|---|---|---|---|---|---|
| fetch | directo | 3 | 2 | 298 ms | 10100 |
| search | ddg | 3 | 0 | — ms | 0 |

Detalle por llamada:

- fetch directo https://example.com/: ok en 138 ms (171 chars)
- fetch directo https://es.wikipedia.org/wiki/Asturias: ok en 457 ms (20028 chars)
- fetch directo https://www.filmaffinity.com/es/film809297.html: FALLO en 61 ms: 403 Forbidden for https://www.filmaffinity.com/es/film809297.html
- search ddg horario renfe madrid barcelona manana: FALLO en 87 ms: ddg HTTP 202
- search ddg precio asts spacemobile accion: FALLO en 98 ms: ddg HTTP 202
- search ddg github earendil pi agent framework: FALLO en 41 ms: ddg HTTP 202
