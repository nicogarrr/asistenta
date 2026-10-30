import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Guarda del propio CI: lo que hace que main tenga (o no) un resultado de CI fiable.
const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

function concurrencyBlock(): string {
  const match = workflow.match(/^concurrency:\n((?:[ \t]+.*\n)+)/m);
  if (!match) throw new Error('ci.yml no tiene bloque concurrency');
  return match[1] ?? '';
}

describe('CI workflow', () => {
  it('en main no cancela una ejecución en curso al llegar otro push (solo en PRs)', () => {
    const block = concurrencyBlock();
    expect(block).not.toMatch(/cancel-in-progress:\s*true\s*$/m);
    expect(block).toMatch(
      /cancel-in-progress:\s*\$\{\{\s*github\.event_name == 'pull_request'\s*\}\}/,
    );
  });

  it('sigue ejecutándose en PRs y en cada push a main', () => {
    expect(workflow).toMatch(/^on:\n(?:.*\n)*?\s+pull_request:/m);
    expect(workflow).toMatch(/push:\n\s+branches: \[main\]/);
  });

  it('mide la cobertura en CI y la publica como resumen y artefacto', () => {
    expect(workflow).toMatch(/run: npm test -- --coverage\b/);
    expect(workflow).toContain('scripts/coverage-summary.mjs');
    expect(workflow).toMatch(/name: coverage\n/);
  });

  it('guarda Chromium de Playwright en caché por versión y sigue instalando las dependencias del sistema', () => {
    expect(workflow).toMatch(/path: ~\/\.cache\/ms-playwright/);
    expect(workflow).toMatch(
      /key: playwright-\$\{\{ runner\.os \}\}-\$\{\{ steps\.playwright\.outputs\.version \}\}/,
    );
    expect(workflow).toMatch(
      /cache-hit != 'true'\s*\n\s*run: npx playwright install --with-deps chromium/,
    );
    expect(workflow).toMatch(
      /cache-hit == 'true'\s*\n\s*run: npx playwright install-deps chromium/,
    );
  });
});
