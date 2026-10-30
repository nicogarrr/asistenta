import { describe, expect, it } from 'vitest';
import { checkPatch, isProtectedPath } from '../src/evolve/guard.js';

// Ficheros que cambian qué mide `npx vitest` sin tocar vitest.config ni test/.
describe('el bucle no puede cambiar la configuración de la medición por otra puerta', () => {
  it.each([
    'vitest.workspace.ts',
    'vitest.workspace.json',
    'vitest.projects.mjs',
    'vite.config.ts',
    '.npmrc',
  ])('%s está protegido', (f) => {
    expect(isProtectedPath(f)).toBe(true);
  });

  it('un parche que añade vitest.workspace.ts se rechaza', () => {
    const diff = [
      'diff --git a/vitest.workspace.ts b/vitest.workspace.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/vitest.workspace.ts',
      '@@ -0,0 +1 @@',
      "+export default [{ test: { include: ['src/**/*.check.ts'] } }];",
    ].join('\n');
    expect(checkPatch(diff).map((v) => v.file)).toContain('vitest.workspace.ts');
  });

  it('el código normal sigue siendo editable', () => {
    expect(isProtectedPath('src/tools/reminder.ts')).toBe(false);
    expect(isProtectedPath('docs/vite.md')).toBe(false);
  });
});
