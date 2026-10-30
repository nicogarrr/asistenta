import { defineConfig } from 'vitest/config';

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
    env: { TZ: 'Europe/Madrid' },
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
    // resumen y artefacto. No hay umbral todavía: primero medir, luego subirlo.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text-summary', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
    },
  },
});
