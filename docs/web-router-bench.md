# Benchmark enrutador web — 2026-10-17 (real, no simulado)

Clave TinyFish: NO — pata TinyFish sin medir. Entorno: CI/sandbox Linux, red saliente estandar.

| op | backend | llamadas | ok | latencia mediana | chars medios |
|---|---|---|---|---|---|
| fetch | directo | 3 | 2 | 159 ms | 40850 |
| search | ddg | 3 | 2 | 1287 ms | 1028 |

Detalle por llamada:

- fetch directo https://example.com/: ok en 137 ms (171 chars)
- fetch directo https://es.wikipedia.org/wiki/Asturias: ok en 159 ms (81528 chars)
- fetch directo https://www.filmaffinity.com/es/film809297.html: FALLO en 69 ms: 403 Forbidden for https://www.filmaffinity.com/es/film809297.html
- search ddg horario renfe madrid barcelona manana: ok en 750 ms (913 chars, 5 resultados)
- search ddg precio asts spacemobile accion: ok en 1287 ms (1142 chars, 5 resultados)
- search ddg github earendil pi agent framework: FALLO en 45 ms: ddg HTTP 202
