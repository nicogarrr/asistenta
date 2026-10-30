import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Guarda del propio CI: lo que hace que main tenga (o no) un resultado de CI fiable.
const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const windows = readFileSync(new URL('../.github/workflows/windows.yml', import.meta.url), 'utf8');

/** Lista YAML `- 'x'` bajo la clave `key:` dentro de `section` (indentación fija del fichero). */
function yamlList(section: string, key: string): string[] {
  const match = section.match(new RegExp(`^\\s+${key}:\\n((?:\\s+- .*\\n)+)`, 'm'));
  if (!match) throw new Error(`no hay lista ${key}`);
  return [...(match[1] ?? '').matchAll(/- '([^']+)'/g)].map((m) => m[1] ?? '');
}

/** Glob de GitHub (solo `**` y `*`) a RegExp. */
function globToRegExp(glob: string): RegExp {
  const src = glob
    .split('**')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('.*');
  return new RegExp(`^${src}$`);
}

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

  it('un cambio solo de documentación no lanza CI (ni en PRs ni en main)', () => {
    const pr = workflow.slice(workflow.indexOf('pull_request:'), workflow.indexOf('push:'));
    const push = workflow.slice(workflow.indexOf('push:'), workflow.indexOf('permissions:'));
    for (const section of [pr, push]) {
      expect(yamlList(section, 'paths-ignore')).toEqual(['docs/**', '**/*.md']);
    }
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

  it('Windows va aparte: en main siempre, en PRs solo si tocan lo que sus tests cubren', () => {
    expect(workflow).not.toMatch(/runs-on: windows-latest/);
    expect(windows).toMatch(/runs-on: windows-latest/);
    expect(windows).toMatch(/push:\n\s+branches: \[main\]/);
    const prSection = windows.slice(windows.indexOf('pull_request:'), windows.indexOf('push:'));
    const globs = yamlList(prSection, 'paths').map(globToRegExp);
    const covered = (file: string) => globs.some((re) => re.test(file));

    const tests = [...windows.matchAll(/(test\/[\w.-]+\.test\.ts)/g)].map((m) => m[1] ?? '');
    expect(tests.length).toBeGreaterThan(10);
    const missing: string[] = [];
    for (const file of new Set(tests)) {
      expect(existsSync(new URL(`../${file}`, import.meta.url)), file).toBe(true);
      if (!covered(file)) missing.push(file);
      const code = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      for (const m of code.matchAll(/from '\.\.\/(src\/[^']+)\.js'/g)) {
        const src = `${m[1]}.ts`;
        if (!covered(src)) missing.push(`${src} (de ${file})`);
      }
    }
    expect(missing).toEqual([]);
    expect(covered('.github/workflows/windows.yml')).toBe(true);
    expect(covered('package-lock.json')).toBe(true);
  });
});

describe('workflows: tv-mocks y biome', () => {
  it('los mocks de la tele van en su propio workflow, solo en rutas de la tele', () => {
    expect(workflow).not.toMatch(/tv-mocks:/);
    const tv = readFileSync(new URL('../.github/workflows/tv-mocks.yml', import.meta.url), 'utf8');
    for (const p of [
      "'scripts/tv/**'",
      "'deploy/tv-webos/**'",
      "'.github/workflows/tv-mocks.yml'",
    ]) {
      expect(tv.split(p).length - 1, p).toBe(2); // en pull_request y en push
    }
    for (const m of tv.matchAll(/run: (scripts\/tv\/[\w.-]+)/g)) {
      expect(existsSync(new URL(`../${m[1]}`, import.meta.url)), m[1]).toBe(true);
    }
  });

  it('biome también revisa los .mjs (scripts/, qa/)', () => {
    const biome = JSON.parse(readFileSync(new URL('../biome.json', import.meta.url), 'utf8')) as {
      files: { includes: string[] };
    };
    expect(biome.files.includes).toContain('**/*.mjs');
  });
});
