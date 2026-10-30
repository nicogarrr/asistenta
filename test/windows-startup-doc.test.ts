/**
 * docs/windows-startup.md explica el vigilante de Windows (#746): nombre de la tarea,
 * cada cuánto corre, qué hace tras `pa stop` y cómo apagarlo con PA_WATCHDOG.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  describeDecision,
  WATCHDOG_INTERVAL_MIN,
  WATCHDOG_TASK_NAME,
} from '../src/autostart-watchdog.js';

const doc = readFileSync(new URL('../docs/windows-startup.md', import.meta.url), 'utf8');

describe('docs/windows-startup.md: el vigilante', () => {
  it('tiene su apartado con el nombre real de la tarea y el intervalo', () => {
    expect(doc).toMatch(/^## Vigilante/m);
    expect(doc).toContain(WATCHDOG_TASK_NAME);
    expect(doc).toContain(`cada ${WATCHDOG_INTERVAL_MIN} min`);
    expect(doc).toContain('autostart vigilar');
  });

  it('explica pa stop, PA_WATCHDOG=0 y dónde ver la última decisión', () => {
    expect(doc).toContain('PA_WATCHDOG=0');
    expect(doc).toContain('pa stop');
    expect(doc).toContain('vigilante.json');
    expect(doc).toContain(describeDecision({ action: 'skip', reason: 'dudoso' }));
    expect(doc).toContain(describeDecision({ action: 'skip', reason: 'parado-a-proposito' }));
  });
});
