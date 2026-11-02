import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import { createReminderTool } from '../src/tools/reminder.js';

// asis-bugs-18: al cancelar un recordatorio que no existe, la respuesta repetía lo
// buscado en minúsculas («No encuentro ningún recordatorio con "maría"» para «María»).
describe('recordatorio cancel: repite lo buscado tal como lo dijo el dueño', () => {
  it('«María» no encontrado y «Comprar» con dos resultados conservan las mayúsculas', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rem18-'));
    const store = new Store(join(dir, 'db.sqlite'));
    try {
      const tool = createReminderTool({
        store,
        scopeOf: () => 'tg:1:2',
        sync: () => {},
        now: () => new Date(2026, 10, 2, 10, 0).getTime(),
      });
      const run = async (args: Record<string, unknown>) => {
        const res = await tool.execute('id', args as never);
        const first = res.content[0];
        return first && first.type === 'text' ? first.text : '';
      };
      await run({ action: 'create', text: 'comprar pan', in_minutes: 60 });
      await run({ action: 'create', text: 'comprar café', in_minutes: 120 });
      expect(await run({ action: 'cancel', text: 'Llamar a María' })).toBe(
        'No encuentro ningún recordatorio con "Llamar a María".',
      );
      expect(await run({ action: 'cancel', text: 'Comprar' })).toMatch(
        /^Hay 2 recordatorios con "Comprar": /,
      );
      expect(await run({ action: 'cancel', text: 'CAFE' })).toContain('Cancelado');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
