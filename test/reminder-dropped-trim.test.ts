import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DROPPED_FILE_MAX_BYTES,
  readDroppedReminders,
  recordDroppedReminder,
} from '../src/tools/reminder.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('recordatorios perdidos: el fichero no crece para siempre', () => {
  it('pasado el tope guarda solo lo reciente y /estado sigue viéndolo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-dropped-'));
    dirs.push(dir);
    const file = join(dir, 'dropped.jsonl');
    const now = Date.parse('2026-10-31T10:00:00Z');
    const old = Array.from({ length: 2000 }, (_, i) =>
      JSON.stringify({ at: now - 400 * 86_400_000 + i, text: `viejo ${i} ${'x'.repeat(40)}` }),
    );
    writeFileSync(file, `${old.join('\n')}\nbasura no json\n`);
    recordDroppedReminder(file, 'llamar a mamá', now);
    expect(statSync(file).size).toBeLessThan(DROPPED_FILE_MAX_BYTES);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('viejo');
    expect(readDroppedReminders(file, now).join(' ')).toContain('llamar a mamá');
  });

  it('por debajo del tope no reescribe nada', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-dropped-'));
    dirs.push(dir);
    const file = join(dir, 'dropped.jsonl');
    const now = Date.parse('2026-10-31T10:00:00Z');
    writeFileSync(file, `${JSON.stringify({ at: now - 90 * 86_400_000, text: 'antiguo' })}\n`);
    recordDroppedReminder(file, 'otro', now);
    expect(readFileSync(file, 'utf8')).toContain('antiguo');
  });
});
