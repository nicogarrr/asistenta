import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Routine, Store } from '../src/db.js';
import { createReminderTool, pickReminder, type ReminderRow } from '../src/tools/reminder.js';

/**
 * Con «comprar pan» y «comprar pan integral» a la vez, cancelar «comprar pan» encontraba
 * los dos y contestaba «Hay 2… Dime cuál»; el modelo solo puede cancelar por texto, así que
 * «comprar pan» no se podía quitar nunca. Ahora, si uno se llama exactamente así, es ese.
 */
describe('cancelar un recordatorio cuyo texto está dentro de otro', () => {
  it('la herramienta cancela el que se llama exactamente así', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rem25-'));
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
      await run({ action: 'create', text: 'comprar pan integral', in_minutes: 120 });
      expect(await run({ action: 'cancel', text: 'Comprar pan' })).toBe('Cancelado: comprar pan.');
      expect(await run({ action: 'list' })).toContain('comprar pan integral');
      expect(await run({ action: 'list' })).not.toMatch(/- comprar pan \|/);
      // Una palabra suelta que está en varios sigue preguntando.
      await run({ action: 'create', text: 'comprar pan', in_minutes: 60 });
      expect(await run({ action: 'cancel', text: 'pan' })).toMatch(
        /^Hay 2 recordatorios con "pan": /,
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('/recordatorios borrar elige el que se llama exactamente así', () => {
    const row = (name: string, prompt: string): ReminderRow => ({
      routine: {
        id: name,
        scope: 'chat',
        name,
        kind: 'schedule',
        prompt,
        schedule: '0 9 * * *',
      } as Routine,
      next: null,
    });
    const rows = [
      row('recordatorio:pan', 'Comprar pan'),
      row('recordatorio:pan2', 'Comprar pan integral'),
    ];
    const r = pickReminder(rows, 'comprar pan');
    expect(r.ok && r.routine.prompt).toBe('Comprar pan');
    expect(pickReminder(rows, 'pan').ok).toBe(false);
  });
});
