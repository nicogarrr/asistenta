import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import { createReminderTool } from '../src/tools/reminder.js';

/**
 * Dos recordatorios con EL MISMO texto («pastilla» a las 9 y a las 21) no se podían
 * cancelar por la herramienta: cancel solo miraba el texto, contestaba «Hay 2… Dime cuál»
 * sin decir la hora de cada uno y no había forma de elegir. Ahora la respuesta da la hora
 * y cancel acepta `at` (HH:MM o YYYY-MM-DDTHH:MM) para quitar el de esa hora.
 */
describe('cancelar uno de dos recordatorios con el mismo texto', () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'rem26-'));
    const store = new Store(join(dir, 'db.sqlite'));
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
    const close = () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    };
    return { run, close };
  };

  it('repetidos: la pregunta da la hora y cancel con at quita el de esa hora', async () => {
    const { run, close } = setup();
    try {
      expect(await run({ action: 'create', text: 'pastilla', schedule: '0 9 * * *' })).not.toMatch(
        /necesita|debe/,
      );
      await run({ action: 'create', text: 'pastilla', schedule: '0 21 * * *' });
      const ask = await run({ action: 'cancel', text: 'pastilla' });
      expect(ask).toMatch(/^Hay 2 recordatorios con "pastilla": /);
      expect(ask).toContain('09:00');
      expect(ask).toContain('21:00');
      expect(await run({ action: 'cancel', text: 'pastilla', at: '21:00' })).toBe(
        'Cancelado: pastilla (21:00).',
      );
      const list = await run({ action: 'list' });
      expect(list).toContain('pastilla');
      expect(list).toMatch(/09:00/);
      expect(list).not.toMatch(/21:00/);
      // Una hora que no es de ninguno no borra nada.
      expect(await run({ action: 'cancel', text: 'pastilla', at: '10:00' })).toMatch(
        /No encuentro ningún recordatorio con "pastilla" a las 10:00/,
      );
      expect(await run({ action: 'list' })).toContain('pastilla');
    } finally {
      close();
    }
  });

  it('puntuales: cancel con la fecha y hora completas', async () => {
    const { run, close } = setup();
    try {
      const d = new Date(Date.now() + 2 * 86_400_000);
      const p = (n: number) => String(n).padStart(2, '0');
      const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      await run({ action: 'create', text: 'llamar a mamá', at: `${day}T09:00` });
      await run({ action: 'create', text: 'llamar a mamá', at: `${day}T21:30` });
      expect(await run({ action: 'cancel', text: 'mamá' })).toMatch(/^Hay 2 recordatorios/);
      expect(await run({ action: 'cancel', text: 'mamá', at: `${day}T09:00` })).toMatch(
        /^Cancelado: llamar a mamá/,
      );
      const list = await run({ action: 'list' });
      expect(list).toContain('21:30');
      expect(list).not.toMatch(/ 09:00/);
    } finally {
      close();
    }
  });

  it('con uno solo, at no estorba ni cambia la respuesta de siempre', async () => {
    const { run, close } = setup();
    try {
      await run({ action: 'create', text: 'regar', schedule: '0 8 * * *' });
      expect(await run({ action: 'cancel', text: 'regar' })).toBe('Cancelado: regar.');
    } finally {
      close();
    }
  });
});
