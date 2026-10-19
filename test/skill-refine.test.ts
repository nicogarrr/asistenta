/**
 * In-use skill improvement (Hermes loop): a lesson seen once is a hint; seen
 * twice it is a pattern and gets noted on the affected skill at once.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordLessons } from '../src/skills/lessons.js';
import { refineFromLessons } from '../src/skills/refine.js';
import { SkillStore } from '../src/skills/store.js';

vi.mock('../src/log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

let dir: string;
let store: SkillStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'refine-'));
  store = new SkillStore({ dir });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const FAIL_THEN_FIX = [
  { tool: 'renfe', action: 'buscar', ok: false },
  { tool: 'browser', action: 'ir', ok: true },
];

function plantSkill(): void {
  store.save({
    name: 'renfe trayectos',
    description: 'Buscar trenes en Renfe.',
    category: 'viajes',
    whenToUse: 'Cuando el usuario pida un tren.',
    steps: ['Abre renfe.com y busca el trayecto.'],
  });
}

describe('refineFromLessons', () => {
  it('a lesson seen once does not touch any skill', () => {
    plantSkill();
    const ids = recordLessons(store, FAIL_THEN_FIX, '2026-10-19');
    expect(ids).toHaveLength(1);
    expect(refineFromLessons(store, ids, '2026-10-19')).toEqual([]);
    expect(store.read('renfe-trayectos')?.notes).toHaveLength(0);
  });

  it('a reincident lesson is noted on the matching skill, idempotently', () => {
    plantSkill();
    recordLessons(store, FAIL_THEN_FIX, '2026-10-18');
    const ids = recordLessons(store, FAIL_THEN_FIX, '2026-10-19');
    const lesson = store.read(ids[0] ?? '');
    expect(lesson?.version).toBe(2);

    const refined = refineFromLessons(store, ids, '2026-10-19');
    expect(refined).toEqual(['renfe-trayectos']);
    const skill = store.read('renfe-trayectos');
    expect(skill?.steps).toEqual(['Abre renfe.com y busca el trayecto.']);
    expect(skill?.notes.some((n) => n.includes('renfe:buscar') && n.includes('browser:ir'))).toBe(
      true,
    );

    // A second refine of the same lesson adds nothing.
    expect(refineFromLessons(store, ids, '2026-10-19')).toEqual([]);
    expect(
      store.read('renfe-trayectos')?.notes.filter((n) => n.includes('renfe:buscar')),
    ).toHaveLength(1);
  });

  it('ignores lessons with no matching skill and never throws', () => {
    recordLessons(store, FAIL_THEN_FIX, '2026-10-18');
    const ids = recordLessons(store, FAIL_THEN_FIX, '2026-10-19');
    expect(refineFromLessons(store, ids, '2026-10-19')).toEqual([]);
    expect(refineFromLessons(store, ['no-existe'], '2026-10-19')).toEqual([]);
  });
});
