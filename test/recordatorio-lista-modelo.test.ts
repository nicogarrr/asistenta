import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import { createReminderTool } from '../src/tools/reminder.js';

// gertru-gaps-7: action=list daba al modelo el cron crudo («repite (30 8 * * 1)») y el
// modelo se lo leía al dueño. Ahora dice lo mismo que /recordatorios.
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
  dir = mkdtempSync(join(tmpdir(), 'rem-lista-'));
  store = new Store(join(dir, 'db.sqlite'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('recordatorios: la lista que ve el modelo, en castellano', () => {
  it('los que se repiten dicen «cada lunes a las 08:30», sin el cron', async () => {
    await run({ action: 'create', text: 'revisar los correos', schedule: '30 8 * * 1' });
    await run({ action: 'create', text: 'regar', schedule: '0 20 * * 1-5', until: '2026-12-31' });
    const list = await run({ action: 'list' });
    expect(list).toContain('revisar los correos | se repite cada lunes a las 08:30');
    expect(list).toContain('regar | se repite de lunes a viernes a las 20:00 hasta 2026-12-31');
    expect(list).not.toContain('30 8 * * 1');
    expect(list).not.toContain('1-5');
  });

  it('el «próximo» va como en /recordatorios (día y hora local)', async () => {
    await run({ action: 'create', text: 'llamar al dentista', at: '2026-10-06T09:00' });
    const list = await run({ action: 'list' });
    // El día de la semana depende del año en que se mire (el cron fijado no lleva año).
    expect(list).toMatch(/llamar al dentista \| una vez \| próximo: \S{3} 06\/10 09:00 \(en /);
    expect(list).not.toContain('2026-10-06T09:00');
  });
});
