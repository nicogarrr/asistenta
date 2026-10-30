# Auto-mejora: el examen de la batería

La auto-mejora (`pa evolve`, `/evolucion`) vive entera en `src/evolve/`. Un cambio propuesto solo
sale como candidato (rama + parche + receipt, que luego es un PR que Nico aprueba) si:

1. no toca nada protegido (`guard.ts` + `FORBIDDEN` en `score.ts`: permisos, aprobaciones, pagos,
   vault, la propia batería, tests, deploy…);
2. mejora la suite (tests, tsc, biome) y pasa la checklist de verificación;
3. **aprueba la batería** (`evolve/battery.json`, 74 casos): ningún caso que pasaba en el
   kernel deja de pasar y la nota no baja (`battery-gate.ts`).

Sin batería configurada no se promueve nada.

## Configuración

- `PA_EVOLVE_PROPOSER`: comando que escribe el cambio en la carpeta del intento.
- `PA_EVOLVE_BATTERY`: comando que corre **un** caso contra el código de su carpeta (cwd). El caso
  llega como JSON en `PA_BATTERY_CASE`; la última línea de su salida debe ser la traza JSON
  (`{"reply": "...", "toolCalls": [...], "approvalsAsked": 0, ...}`, ver `battery-judge.ts`).
  Recibe el mismo entorno limpio que el proponedor (solo las claves de `PA_EVOLVE_PROPOSER_PASS`).
- **Sin definir** se usa `scripts/evolve-battery-case.mjs` con el mismo Node: corre el caso con el
  código fuente de la copia que se mide, datos en una carpeta temporal que se borra y sin cuentas
  reales. Memoria y recordatorios funcionan de verdad (en esa carpeta); correo, navegador, web,
  shell, ficheros, Renfe y PC existen con su nombre pero no hacen nada y quedan en la traza. Toda
  petición de aprobación se cuenta y se deniega. El modelo es el de tu configuración: pon en
  `PA_EVOLVE_PROPOSER_PASS` las variables que necesita: `PA_PROVIDER,PA_MODEL,PA_BASE_URL,PA_PROVIDER_PRESET,PA_SECRET_PROVIDER_APIKEY`.
  El evaluador no ve el almacén cifrado de Windows (sus datos están en una carpeta temporal), así que la
  clave del modelo tiene que estar también en la variable `PA_SECRET_PROVIDER_APIKEY` (el evaluador usa
  el almacén portátil, que la lee de ahí). No existe `PA_API_KEY`.
- `PA_EVOLVE_BATTERY=off` apaga el evaluador: entonces ningún cambio se aprueba.

## Cómo se puntúa

- Cada caso activo que juzga la máquina se repite 3 veces y pasa por mayoría; si el comando falla,
  cuenta como fallo. Los fallos de entorno declarados (`envError`) no cuentan.
- Los casos `heavy` rotan por semana ISO (un tercio cada semana, salvo los `always`); base y
  candidato corren la misma selección.
- Los casos desactivados, `qa` o sin criterio de máquina no puntúan (`unscored()` los explica).
