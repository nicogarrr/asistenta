import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scheduleEs } from '../src/cron/describe-es.js';
import { Store } from '../src/db.js';
import { createReminderTool } from '../src/tools/reminder.js';

/**
 * El planificador acepta días y meses con nombre («0 9 * * MON-FRI», «sun», «DEC») y el
 * modelo a veces los escribe así, pero no se sabían decir: el aviso contestaba «repite
 * 0 9 * * MON-FRI» y la lista «se repite con un horario propio». Ahora se dicen en castellano.
 */
describe('cron con nombres de día o mes, en castellano', () => {
  it.each([
    ['0 9 * * MON-FRI', 'de lunes a viernes a las 09:00'],
    ['5 4 * * sun', 'cada domingo a las 04:05'],
    ['0 10 * * SAT,SUN', 'los fines de semana a las 10:00'],
    ['0 9 * * mon,wed,fri', 'los lunes, miércoles y viernes a las 09:00'],
    ['0 9 * DEC 1', 'cada lunes a las 09:00, en diciembre'],
    ['30 8 * jan-mar mon', 'cada lunes a las 08:30, de enero a marzo'],
  ])('%s → %s', (cron, said) => {
    expect(scheduleEs(cron)).toBe(said);
  });

  it('lo que no se sabe decir sigue en null', () => {
    expect(scheduleEs('0 9 * * xyz')).toBeNull();
    expect(scheduleEs('0 9 * * 1-5')).toBe('de lunes a viernes a las 09:00');
  });

  it('el recordatorio lo dice así al crearlo y en la lista', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cron26-'));
    const store = new Store(join(dir, 'db.sqlite'));
    try {
      const tool = createReminderTool({
        store,
        scopeOf: () => 'tg:1:2',
        sync: () => {},
        now: () => Date.now(),
      });
      const run = async (args: Record<string, unknown>) => {
        const res = await tool.execute('id', args as never);
        const first = res.content[0];
        return first && first.type === 'text' ? first.text : '';
      };
      const made = await run({ action: 'create', text: 'gimnasio', schedule: '0 9 * * MON-FRI' });
      expect(made).toContain('de lunes a viernes a las 09:00');
      expect(made).not.toContain('MON-FRI');
      expect(await run({ action: 'list' })).toContain('se repite de lunes a viernes a las 09:00');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
