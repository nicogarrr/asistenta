import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import { skipsHolidays } from '../src/festivos-rutinas.js';
import { createReminderTool } from '../src/tools/reminder.js';

const textOf = (r: { content: Array<{ type: string; text?: string }> }): string =>
  r.content.map((c) => c.text ?? '').join('');

describe('recordatorio «excepto festivos» (festivos1)', () => {
  it('se guarda marcado para saltarse los festivos y la respuesta dice cuáles cuentan', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fest1-'));
    const store = new Store(join(dir, 'db.sqlite'));
    try {
      const tool = createReminderTool({
        store,
        scopeOf: () => 'tg:1:2',
        sync: () => {},
        now: () => Date.parse('2026-12-07T10:00:00+01:00'),
      });
      const res = await tool.execute('1', {
        action: 'create',
        text: 'sacar la basura',
        schedule: '0 20 * * 1-5',
        skip_holidays: true,
      } as never);
      expect(textOf(res as never)).toContain('excepto festivos nacionales y de');
      const [saved] = store.listRoutines('tg:1:2');
      expect(saved && skipsHolidays(`${saved.name} ${saved.prompt ?? ''}`)).toBe(true);

      const plain = await tool.execute('2', {
        action: 'create',
        text: 'regar',
        schedule: '0 9 * * 1',
      } as never);
      expect(textOf(plain as never)).not.toContain('festivos');
      const regar = store.listRoutines('tg:1:2').find((r) => r.prompt === 'regar');
      expect(regar && skipsHolidays(`${regar.name} ${regar.prompt ?? ''}`)).toBe(false);

      const once = await tool.execute('3', {
        action: 'create',
        text: 'llamar',
        in_minutes: 30,
        skip_holidays: true,
      } as never);
      expect(textOf(once as never)).toContain('solo vale con schedule');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
