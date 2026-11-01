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

// README.md en inglés y README.es.md en castellano (Nico, 1 nov): los dos enlazan igual.

/** GitHub's heading anchor: lowercase, drop punctuation (keeps letters, digits, - and _), spaces → -. */
function githubSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

describe.each([
  { fichero: 'README.es.md', titulo: '## Arranque automático' },
  { fichero: 'README.md', titulo: '## Autostart' },
])('$fichero: arranque automático lleva a docs/windows-startup.md', ({ fichero, titulo }) => {
  const readme = readFileSync(new URL(`../${fichero}`, import.meta.url), 'utf8');
  const start = readme.indexOf(titulo);
  it('tiene el apartado', () => expect(start).toBeGreaterThan(-1));
  const next = readme.indexOf('\n## ', start + 1);
  const section = readme.slice(start, next < 0 ? undefined : next);

  it('enlaza la guía de Windows y el apartado del vigilante con un ancla que existe', () => {
    expect(section).toContain('](docs/windows-startup.md)');
    const heading = doc.match(/^## (Vigilante.*)$/m)?.[1] ?? '';
    expect(heading).not.toBe('');
    expect(section).toContain(`](docs/windows-startup.md#${githubSlug(heading)})`);
    expect(section).toContain(WATCHDOG_TASK_NAME);
  });

  it('dice qué hace pa stop con el vigilante', () => {
    expect(section).toContain('pa stop');
    expect(section).toContain('pa iniciar');
  });
});
