# Benchmark enrutador web — 2026-10-17 (real, no simulado)

Clave TinyFish: SI (vault). Entorno: CI/sandbox Linux, red saliente estandar. chars = texto entregado tras el truncado de 20k de la lectura; latencia = mediana estadistica.

| op | backend | llamadas | ok | latencia mediana (ms) | chars entregados medios |
|---|---|---|---|---|---|
| fetch | directo | 3 | 2 | 131 ms | 10100 |
| search | tinyfish | 3 | 3 | 148 ms | 981 |
| fetch | tinyfish | 3 | 3 | 1041 ms | 8583 |
| search | ddg | 3 | 0 | — ms | 0 |

Detalle por llamada:

- fetch directo https://example.com/: ok en 91 ms (171 chars)
- fetch directo https://es.wikipedia.org/wiki/Asturias: ok en 171 ms (20028 chars)
- fetch directo https://www.filmaffinity.com/es/film809297.html: FALLO en 66 ms: 403 Forbidden for https://www.filmaffinity.com/es/film809297.html
- search tinyfish horario renfe madrid barcelona manana: ok en 148 ms (920 chars, 5 resultados)
- search tinyfish precio asts spacemobile accion: ok en 140 ms (1027 chars, 5 resultados)
- search tinyfish github earendil pi agent framework: ok en 154 ms (995 chars, 5 resultados)
- fetch tinyfish https://example.com/: ok en 438 ms (156 chars)
- fetch tinyfish https://es.wikipedia.org/wiki/Asturias: ok en 2127 ms (20028 chars)
- fetch tinyfish https://www.filmaffinity.com/es/film809297.html: ok en 1041 ms (5566 chars)
- search ddg horario renfe madrid barcelona manana: FALLO en 85 ms: ddg HTTP 202
- search ddg precio asts spacemobile accion: FALLO en 86 ms: ddg HTTP 202
- search ddg github earendil pi agent framework: FALLO en 41 ms: ddg HTTP 202
