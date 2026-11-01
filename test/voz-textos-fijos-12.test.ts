import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatLlmHealth } from '../src/llm-health.js';

// Nico (31 oct): que Asistenta hable como en un chat. `pa llm-health` sacaba
// «zen/m: red (http -, 0ms) :: fetch failed», «key lookup fallo» o «http 2xx sin
// choices». Ahora cada modelo dice en castellano si funciona y, si no, por qué.
describe('textos fijos sin jerga (12): pa llm-health', () => {
  it('cada estado en castellano llano', () => {
    const out = formatLlmHealth([
      { provider: 'zen', model: 'm1', status: 'ok', http: 200, latencyMs: 350 },
      { provider: 'openrouter', model: 'm2', status: 'auth', http: 401, latencyMs: 90 },
      { provider: 'gemini', model: 'm3', status: 'sin-key', latencyMs: 0 },
      { provider: 'otro', model: 'm4', status: 'timeout', latencyMs: 15000 },
    ]);
    expect(out.split('\n')).toEqual([
      'zen · m1: funciona (350 ms)',
      'openrouter · m2: clave rechazada (error 401, 90 ms)',
      'gemini · m3: sin clave guardada',
      'otro · m4: no contesta a tiempo (15000 ms)',
    ]);
  });

  it('sin «http -», «::» ni el código interno', () => {
    const out = formatLlmHealth([
      { provider: 'zen', model: 'm1', status: 'red', latencyMs: 0, detail: 'sin red' },
    ]);
    expect(out).toBe('zen · m1: no hay conexión — sin red');
    expect(out).not.toMatch(/http -|::|\bred\b \(/);
  });

  it('los avisos propios ya no mezclan inglés', () => {
    const src = readFileSync('src/llm-health.ts', 'utf8');
    expect(src).not.toContain('key lookup fallo');
    expect(src).not.toContain('loadConfig fallo');
    expect(src).not.toContain('sin choices de contenido');
  });
});
