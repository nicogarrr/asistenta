import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { expect, it } from 'vitest';
import { loadConfig, resetConfigForTests } from '../src/config.js';

it('keeps the onboarding sample non-secret and accepted by the current configuration', () => {
  const env = parseEnv(readFileSync(resolve('.env.example'), 'utf8'));
  expect(env).toEqual({ PA_PROVIDER_PRESET: 'opencode', PA_DESKTOP: 'off' });
  const previous = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith('PA_')) delete process.env[key];
    Object.assign(process.env, env);
    resetConfigForTests();
    expect(loadConfig().providerPreset).toBe('opencode');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    resetConfigForTests();
  }
});
it('does not link onboarding readers to missing local documentation', () => {
  const text = readFileSync(resolve('README.md'), 'utf8');
  for (const hit of text.matchAll(/\]\(([^)]+)\)/g)) {
    const link = hit[1] ?? '';
    if (link.startsWith('http')) continue;
    if (link.startsWith('#')) {
      // In-page anchor: it must match a heading slug in this README.
      const slugs = [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) =>
        (m[1] ?? '')
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s-]/gu, '')
          .trim()
          .replace(/\s+/g, '-'),
      );
      expect(slugs, link).toContain(link.slice(1));
      continue;
    }
    expect(existsSync(resolve(link.split('#')[0] ?? link)), link).toBe(true);
  }
  expect(text).not.toContain('En Windows todavía no hay controlador');
  expect(text).not.toContain('La supervisión continua aún no está disponible');
  expect(text).not.toContain('autodetección por `/start` todavía no está implementada');
  expect(text).toContain('`restart` se rechaza');
  expect(text).toContain('puede quedar en historial');
});

it('README: «Empieza aquí» en 10 pasos o menos, lleva a instalar.bat y dice qué es de pago', () => {
  const text = readFileSync(resolve('README.md'), 'utf8');
  const start = text.indexOf('## Empieza aquí');
  expect(start).toBeGreaterThan(-1);
  expect(start).toBeLessThan(text.indexOf('## Qué puedes hacer'));
  const section = text.slice(start, text.indexOf('\n## ', start + 3));
  const steps = section.match(/^\d+\. /gm) ?? [];
  expect(steps.length).toBeGreaterThan(0);
  expect(steps.length).toBeLessThanOrEqual(10);
  expect(section).toContain('instalar.bat');
  expect(section).toContain('levantar.bat');
  expect(text).toContain('Lo único de pago es **la clave del modelo**');
});
