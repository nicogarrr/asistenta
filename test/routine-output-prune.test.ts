import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ROUTINE_OUTPUT_KEEP_DAYS, writeRoutineOutput } from '../src/routine-delivery.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function day(base: Date, back: number): string {
  const d = new Date(base.getTime() - back * 86_400_000);
  return d.toISOString().slice(0, 10);
}

describe('salidas de rutina: no crecen para siempre', () => {
  it('guarda los últimos días y borra solo los ficheros de fecha más viejos', () => {
    const base = mkdtempSync(join(tmpdir(), 'pa-salidas-'));
    dirs.push(base);
    const dir = join(base, 'informe');
    mkdirSync(dir, { recursive: true });
    const now = new Date('2026-10-31T10:00:00Z');
    for (let i = 1; i <= 400; i++) writeFileSync(join(dir, `${day(now, i)}.md`), 'x');
    writeFileSync(join(dir, 'notas.md'), 'mío');
    writeFileSync(join(dir, '2020-01-01.txt'), 'mío');
    writeFileSync(join(dir, '2099-01-01.md'), 'futuro');
    const file = writeRoutineOutput(base, 'informe', 'hola', now);
    const left = readdirSync(dir);
    const dated = left.filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n) && n < '2099');
    expect(dated.length).toBe(ROUTINE_OUTPUT_KEEP_DAYS);
    expect(existsSync(file)).toBe(true);
    expect(left).toContain(`${day(now, 1)}.md`);
    expect(left).not.toContain(`${day(now, 200)}.md`);
    expect(left).toEqual(expect.arrayContaining(['notas.md', '2020-01-01.txt', '2099-01-01.md']));
  });

  it('con pocos días no borra nada', () => {
    const base = mkdtempSync(join(tmpdir(), 'pa-salidas-'));
    dirs.push(base);
    const now = new Date('2026-10-31T10:00:00Z');
    writeRoutineOutput(base, 'r', 'a', new Date('2026-10-29T10:00:00Z'));
    writeRoutineOutput(base, 'r', 'b', now);
    expect(readdirSync(join(base, 'r')).length).toBe(2);
  });
});
