import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
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
  },
});
