/**
 * Una receta que se repite se ofrece una vez como habilidad; el dueño dice sí
 * (skills accept) y queda guardada pidiendo permiso antes de actuar hacia fuera.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunStep } from '../src/skills/lessons.js';
import { MAX_TRACKED, RepeatTracker, recipeOf } from '../src/skills/repeats.js';
import { SkillStore } from '../src/skills/store.js';
import { createSkillsTool } from '../src/tools/skills.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const RUN: RunStep[] = [
  { tool: 'mail', action: 'search', ok: true },
  { tool: 'memory', action: 'recall', ok: true },
  { tool: 'calendar', action: 'create', ok: true },
  { tool: 'tareas', action: 'add', ok: true },
  { tool: 'done', action: '', ok: true },
];

let dir = '';
let store: SkillStore;
let file = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-repeats-'));
  store = new SkillStore({ dir: join(dir, 'skills') });
  file = join(dir, 'repetidas.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

function text(res: { content: { type: string; text?: string }[] }): string {
  return res.content.map((p) => p.text ?? '').join('\n');
}

describe('recetas repetidas', () => {
  it('la receta ignora lo que solo mira o apunta, y los pasos fallidos', () => {
    expect(recipeOf([...RUN, { tool: 'browser', action: 'open', ok: false }])).toEqual([
      'mail: search',
      'calendar: create',
      'tareas: add',
    ]);
  });

  it('a la tercera vez ofrece guardarla en una línea, y solo una vez', () => {
    const tracker = new RepeatTracker(file);
    expect(tracker.observe(RUN, store.list())).toBeNull();
    expect(tracker.observe(RUN, store.list())).toBeNull();
    const offer = tracker.observe(RUN, store.list());
    expect(offer?.line).toContain('¿Lo guardo como habilidad?');
    expect(offer?.line.split('\n')).toHaveLength(1);
    expect(offer?.draft.outward).toBe(true);
    // Sobrevive a un reinicio y no se vuelve a ofrecer.
    const again = new RepeatTracker(file);
    expect(again.observe(RUN, store.list())).toBeNull();
    expect(again.pending?.draft.steps).toEqual(['mail: search', 'calendar: create', 'tareas: add']);
  });

  it('no ofrece si ya hay una habilidad con esos pasos ni si son pocos pasos', () => {
    store.save({
      name: 'Mi rutina',
      description: 'la mía',
      category: 'general',
      whenToUse: 'siempre',
      steps: ['mail: search', 'calendar: create', 'tareas: add'],
    });
    const tracker = new RepeatTracker(file);
    for (let i = 0; i < 4; i++) expect(tracker.observe(RUN, store.list())).toBeNull();
    const short: RunStep[] = [
      { tool: 'mail', action: 'search', ok: true },
      { tool: 'tareas', action: 'add', ok: true },
    ];
    for (let i = 0; i < 4; i++) expect(tracker.observe(short, [])).toBeNull();
  });

  it('el sí del dueño (skills accept) la guarda con outward y la quita de pendientes', async () => {
    const tracker = new RepeatTracker(file);
    for (let i = 0; i < 3; i++) tracker.observe(RUN, store.list());
    const tool = createSkillsTool({ store, repeats: tracker });
    const res = await tool.execute('a1', { action: 'accept' }, undefined, undefined);
    expect(text(res)).toContain('Guardada como habilidad');
    const saved = store.list().find((s) => s.category === 'repetidas');
    expect(saved?.outward).toBe(true);
    expect(saved?.steps).toEqual(['mail: search', 'calendar: create', 'tareas: add']);
    const twice = await tool.execute('a2', { action: 'accept' }, undefined, undefined);
    expect(text(twice)).toContain('No tengo ninguna habilidad pendiente');
  });

  it('un fichero roto empieza de cero y el registro no crece sin límite', () => {
    writeFileSync(file, '{no es json');
    const tracker = new RepeatTracker(file);
    for (let i = 0; i < MAX_TRACKED + 20; i++) {
      tracker.observe(
        [
          { tool: 'mail', action: 'search', ok: true },
          { tool: 'calendar', action: 'create', ok: true },
          { tool: `t${i}`, action: '', ok: true },
        ],
        [],
        i,
      );
    }
    expect(existsSync(file)).toBe(true);
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { entries: object };
    expect(Object.keys(saved.entries).length).toBe(MAX_TRACKED);
  });

  it('cli.ts añade la oferta solo en el chat del dueño', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toContain('skillRepeats.observe(result.steps');
    expect(cli).toMatch(
      /isOwnerDm\(inboundFor\(thread\), vigilanteOwnerId\)\) \{\s+const offer = skillRepeats/,
    );
  });
});
