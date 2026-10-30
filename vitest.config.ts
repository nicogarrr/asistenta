import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Los tests NUNCA escriben en el estado real del agente. Sin PA_STATE_DIR, paths.ts
// usa ~/.local/share/personal-agent: la suite dejaba allí perfiles de Chromium,
// browser/grants.json y logs; en el PC de Nico, encima de su estado de verdad.
// Un directorio temporal por ejecución, siempre (aunque la shell traiga otro
// PA_STATE_DIR); los tests que necesitan el suyo lo siguen fijando ellos mismos.
// global-state-dir.ts lo borra al terminar.
const testStateDir = mkdtempSync(join(tmpdir(), 'pa-test-state-'));
process.env.PA_TEST_STATE_DIR = testStateDir;
// Igual con los temporales: cientos de tests hacen mkdtemp(tmpdir()) y no todos
// lo borran (en una máquina compartida /tmp llegó a llenar el disco: 1.235
// pa-goals-* en 45 min). Los workers y los procesos que lanzan ven un tmpdir()
// propio de esta ejecución, que global-state-dir.ts borra entero al terminar.
const testTmpDir = mkdtempSync(join(tmpdir(), 'pa-test-tmp-'));
process.env.PA_TEST_TMP_DIR = testTmpDir;

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The suite asserts local-wall-clock behaviour (calendar days, "tomorrow",
    // quiet hours) and asistenta runs on a machine in Europe/Madrid. Without a
    // fixed zone the same test passes on Nico's PC and fails in a UTC container
    // (7 of the 10 red tests on main there trace to the zone; the other three
    // were a stale fixed date and the pdfjs engine). Pin the zone so the suite means the same
    // thing everywhere; Node reads TZ lazily on Linux, and on Windows the
    // system zone already is Madrid.
    env: {
      TZ: 'Europe/Madrid',
      PA_STATE_DIR: testStateDir,
      TMPDIR: testTmpDir,
      TEMP: testTmpDir,
      TMP: testTmpDir,
    },
    globalSetup: ['test/helpers/global-state-dir.ts'],
    // Generous, because the slow tests are the honest ones: they launch a real Chromium
    // and paint frames with PowerShell and System.Drawing. Both compete for the same
    // processes when the whole suite runs at once, and a 20s budget turned that
    // contention into timeouts that looked like product bugs (a browser test failing
    // only in the full run and never on its own).
    testTimeout: 60_000,
    hookTimeout: 30_000,
    pool: 'forks',
    // Each browser test launches its own persistent context and profile directory.
    // Letting every file in the suite do that at the same time starves them of handles
    // and CPU; eight at a time keeps the wall clock sane and the browsers alive.
    maxWorkers: 8,
    // Cobertura solo cuando se pide (`npm test -- --coverage`); CI la publica como
    // resumen y artefacto. Umbral = línea base medida (30 oct: líneas 78,4 %,
    // ramas 83,3 %) menos un margen pequeño: CI falla si la cobertura baja de ahí.
    // Súbelo cuando la línea base suba; no lo bajes para que pase una PR.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text-summary', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      thresholds: { lines: 81, statements: 81, branches: 84, functions: 84 },
    },
  },
});
