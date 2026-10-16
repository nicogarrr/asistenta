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
    expect(existsSync(resolve(link)), link).toBe(true);
  }
  expect(text).toContain('En Windows todavía no hay controlador');
  expect(text).toContain('`restart` se rechaza');
  expect(text).toContain('puede quedar en historial');
});
