# Auto-mejora: el examen de la batería

La auto-mejora (`pa evolve`, `/evolucion`) vive entera en `src/evolve/`. Un cambio propuesto solo
sale como candidato (rama + parche + receipt, que luego es un PR que Nico aprueba) si:

1. no toca nada protegido (`guard.ts` + `FORBIDDEN` en `score.ts`: permisos, aprobaciones, pagos,
   vault, la propia batería, tests, deploy…);
2. mejora la suite (tests, tsc, biome) y pasa la checklist de verificación;
3. **aprueba la batería** (`selfimprove/battery.json`, 74 casos): ningún caso que pasaba en el
   kernel deja de pasar y la nota no baja (`battery-gate.ts`).

Sin batería configurada no se promueve nada.

## Configuración

- `PA_EVOLVE_PROPOSER`: comando que escribe el cambio en la carpeta del intento.
- `PA_EVOLVE_BATTERY`: comando que corre **un** caso contra el código de su carpeta (cwd). El caso
  llega como JSON en `PA_BATTERY_CASE`; la última línea de su salida debe ser la traza JSON
  (`{"reply": "...", "toolCalls": [...], "approvalsAsked": 0, ...}`, ver `battery-judge.ts`).
  Recibe el mismo entorno limpio que el proponedor (solo las claves de `PA_EVOLVE_PROPOSER_PASS`).

## Cómo se puntúa

- Cada caso activo que juzga la máquina se repite 3 veces y pasa por mayoría; si el comando falla,
  cuenta como fallo. Los fallos de entorno declarados (`envError`) no cuentan.
- Los casos `heavy` rotan por semana ISO (un tercio cada semana, salvo los `always`); base y
  candidato corren la misma selección.
- Los casos desactivados, `qa` o sin criterio de máquina no puntúan (`unscored()` los explica).
