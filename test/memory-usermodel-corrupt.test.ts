import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setAsideCorrupt } from '../src/fs-tmp.js';
import { AUTOSAVE_DAYS, NudgeTracker } from '../src/memory/usermodel.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-usermodel-corrupt-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const file = () => join(dir, 'nudge-tracker.json');
const backups = () => readdirSync(dir).filter((f) => f.startsWith('nudge-tracker.json.corrupt-'));

describe('NudgeTracker con estado corrupto', () => {
  it('aparta el fichero corrupto antes de escribir (no se pierde)', () => {
    writeFileSync(
      file(),
      '{"llego tarde": {"days": ["2026-10-01"], "savedDay": "2026-10-03"',
      'utf8',
    );
    const t = new NudgeTracker(dir);
    expect(t.record('Me gusta el café solo', '2026-10-30')).toBe(false);
    const b = backups();
    expect(b).toHaveLength(1);
    expect(readFileSync(join(dir, b[0] ?? ''), 'utf8')).toContain('savedDay');
    const fresh = JSON.parse(readFileSync(file(), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(fresh)).toHaveLength(1);
  });

  it('un JSON que no es objeto también se aparta', () => {
    writeFileSync(file(), '[1,2,3]', 'utf8');
    new NudgeTracker(dir).record('x', '2026-10-30');
    expect(backups()).toHaveLength(1);
  });

  it('lee un fichero con BOM (editor de Windows) sin tratarlo como corrupto', () => {
    const t0 = new NudgeTracker(dir);
    for (let i = 1; i < AUTOSAVE_DAYS; i++) t0.record('Vivo en Madrid', `2026-10-0${i}`);
    writeFileSync(file(), `\uFEFF${readFileSync(file(), 'utf8')}`, 'utf8');
    const t = new NudgeTracker(dir);
    expect(t.daysFor('Vivo en Madrid')).toBe(AUTOSAVE_DAYS - 1);
    expect(t.record('Vivo en Madrid', '2026-10-30')).toBe(true);
    expect(backups()).toHaveLength(0);
  });

  it('un fichero sano no se aparta', () => {
    const t = new NudgeTracker(dir);
    t.record('a', '2026-10-01');
    new NudgeTracker(dir).record('a', '2026-10-02');
    expect(backups()).toHaveLength(0);
  });
});

describe('setAsideCorrupt', () => {
  it('renombra a .corrupt-<fecha> y devuelve la ruta', () => {
    writeFileSync(file(), 'basura', 'utf8');
    const b = setAsideCorrupt(file());
    expect(existsSync(file())).toBe(false);
    expect(readFileSync(b, 'utf8')).toBe('basura');
    expect(b.startsWith(`${file()}.corrupt-`)).toBe(true);
  });
});
