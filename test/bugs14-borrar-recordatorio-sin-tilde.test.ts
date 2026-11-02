import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Routine, Store } from '../src/db.js';
import { createReminderTool, pickReminder, type ReminderRow } from '../src/tools/reminder.js';

function row(name: string, prompt: string): ReminderRow {
  return {
    routine: {
      id: name,
      scope: 'chat',
      name,
      kind: 'schedule',
      prompt,
      schedule: '0 9 * * *',
    } as Routine,
    next: null,
  };
}

const rows = [
  row('recordatorio-1:jose', 'Llamar a José'),
  row('recordatorio:cafe', 'Comprar café'),
  row('recordatorio:pan', 'Comprar pan'),
];
const picked = (ref: string): string => {
  const r = pickReminder(rows, ref);
  return r.ok ? (r.routine.prompt ?? '') : `ERROR ${r.error}`;
};

describe('/recordatorios borrar: sin tildes y con número escrito a mano (bugs14)', () => {
  it('encuentra la palabra aunque se escriba sin tilde (o con ella)', () => {
    expect(picked('jose')).toBe('Llamar a José');
    expect(picked('cafe')).toBe('Comprar café');
    expect(picked('JOSÉ')).toBe('Llamar a José');
    expect(picked('pán')).toBe('Comprar pan');
  });

  it('«2.», «el 2», «#2» o «nº 2» son el número de la lista', () => {
    expect(picked('2.')).toBe('Comprar café');
    expect(picked('el 2')).toBe('Comprar café');
    expect(picked('#2')).toBe('Comprar café');
    expect(picked('nº 3')).toBe('Comprar pan');
  });

  it('sigue sin borrar si hay duda', () => {
    expect(picked('comprar')).toMatch(/^ERROR Hay 2/);
    expect(picked('9')).toMatch(/^ERROR No hay recordatorio 9/);
  });
});

describe('recordatorio cancel (herramienta): sin tildes (bugs14)', () => {
  it('«cafe» cancela «comprar café»', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rem14-'));
    const store = new Store(join(dir, 'db.sqlite'));
    try {
      const tool = createReminderTool({
        store,
        scopeOf: () => 'tg:1:2',
        sync: () => {},
        now: () => new Date(2026, 9, 5, 10, 0).getTime(),
      });
      const run = async (args: Record<string, unknown>) => {
        const res = await tool.execute('id', args as never);
        const first = res.content[0];
        return first && first.type === 'text' ? first.text : '';
      };
      await run({ action: 'create', text: 'comprar café', in_minutes: 180 });
      expect(await run({ action: 'cancel', text: 'cafe' })).toContain('Cancelado');
      expect(store.listRoutines('tg:1:2')).toHaveLength(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
