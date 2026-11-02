import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import { createReminderTool } from '../src/tools/reminder.js';

// bugs16: al CREAR uno que se repite, la respuesta llevaba el cron crudo («repite 30 8 * * 1»)
// y el modelo se lo leía al dueño (la lista ya se arregló en gertru-gaps-7).
let dir = '';
let store: Store;
const NOW = new Date(2026, 9, 5, 10, 0, 0).getTime();

async function run(args: Record<string, unknown>) {
  const tool = createReminderTool({
    store,
    scopeOf: () => 'tg:1:2',
    sync: () => {},
    now: () => NOW,
  });
  const res = await tool.execute('id', args as never);
  const first = res.content[0];
  return first && first.type === 'text' ? first.text : '';
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rem-crear-'));
  store = new Store(join(dir, 'db.sqlite'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('recordatorios: la confirmación al crear uno que se repite, en castellano', () => {
  it('dice «cada lunes a las 08:30», sin el cron', async () => {
    const out = await run({
      action: 'create',
      text: 'revisar los correos',
      schedule: '30 8 * * 1',
    });
    expect(out).toContain('Recordatorio programado (cada lunes a las 08:30)');
    expect(out).not.toContain('30 8 * * 1');
    // El «próximo» también como en la lista: «lun 05/10 08:30 (en …)», sin «UTC+01:00».
    expect(out).toMatch(/Próximo: \S{3} \d{2}\/\d{2} 08:30 \(en /);
    expect(out).not.toContain('UTC');
  });

  it('con «hasta» y de lunes a viernes, igual que la lista', async () => {
    const out = await run({
      action: 'create',
      text: 'regar',
      schedule: '0 20 * * 1-5',
      until: '2026-12-31',
    });
    expect(out).toContain('(de lunes a viernes a las 20:00 hasta 2026-12-31): regar');
    expect(out).not.toContain('1-5');
  });
});
