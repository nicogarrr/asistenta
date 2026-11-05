import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TELEGRAM_COMMANDS } from '../src/channels/telegram-commands.js';
import { HELP_SECTIONS } from '../src/channels/telegram-help.js';
import {
  COMPRA_CALLBACK_PREFIX,
  CompraStore,
  compraIntent,
  compraPress,
  compraView,
  createCompraTool,
  itemsFromText,
  runCompraIntent,
} from '../src/compra.js';
import { STATE_ENTRIES } from '../src/state-files.js';

const dirs: string[] = [];
const fresh = (key = 'telegram:42:') => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-compra-'));
  dirs.push(dir);
  const file = join(dir, 'lista-compra.json');
  return { file, store: new CompraStore(file, key, () => 1000) };
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('lista de la compra con botones', () => {
  it('«añade leche, pan y 6 huevos a la lista» se apunta sin modelo y trae un botón por cosa', () => {
    const { store } = fresh();
    const intent = compraIntent('Añade leche, pan y 6 huevos a la lista');
    expect(intent).toEqual({ kind: 'add', items: ['leche', 'pan', '6 huevos'] });
    const view = runCompraIntent(store, intent as NonNullable<typeof intent>);
    expect(view.text).toContain('Apuntado: leche, pan, 6 huevos.');
    expect(view.text).toContain('3 por comprar');
    expect(view.buttons.map((b) => b.label)).toEqual(['⬜ leche', '⬜ pan', '⬜ 6 huevos']);
    for (const b of view.buttons) {
      expect(b.action.startsWith(COMPRA_CALLBACK_PREFIX)).toBe(true);
      expect(Buffer.byteLength(b.action)).toBeLessThanOrEqual(64);
    }
  });

  it('tocar un botón la tacha en el mismo mensaje; «🧹 Quitar tachados» la quita', () => {
    const { store } = fresh();
    store.add(['leche', 'pan']);
    const first = compraView(store.list());
    const leche = first.buttons.find((b) => b.label === '⬜ leche');
    const after = compraPress(store, leche?.action ?? '');
    expect(after.text).toContain('1 por comprar');
    expect(after.text).toMatch(/⬜ pan\n✅ leche/);
    const limpiar = after.buttons.find((b) => b.label === '🧹 Quitar tachados');
    expect(limpiar).toBeDefined();
    const clean = compraPress(store, limpiar?.action ?? '');
    expect(clean.text).not.toContain('leche');
    expect(store.list().map((i) => i.text)).toEqual(['pan']);
    // Volver a tocar destacha.
    const pan = clean.buttons[0]?.action ?? '';
    compraPress(store, pan);
    expect(compraPress(store, pan).text).toContain('1 por comprar');
  });

  it('repetir algo no lo duplica; lo tachado vuelve a la lista', () => {
    const { store } = fresh();
    store.add(['Leche']);
    expect(store.add(['leche'])).toEqual({ added: [], already: ['Leche'] });
    store.mark('leche');
    expect(store.add(['leche']).added).toEqual(['Leche']);
    expect(store.list()).toHaveLength(1);
  });

  it('entiende las formas de ver, limpiar y apuntar; «añade leche» a secas va al modelo', () => {
    expect(compraIntent('¿Qué falta en la lista?')).toEqual({ kind: 'show' });
    expect(compraIntent('enséñame la lista de la compra')).toEqual({ kind: 'show' });
    expect(compraIntent('qué me queda por comprar')).toEqual({ kind: 'show' });
    expect(compraIntent('borra lo tachado')).toEqual({ kind: 'clearDone' });
    expect(compraIntent('vacía la lista de la compra')).toEqual({ kind: 'clearAll' });
    expect(compraIntent('apunta tomates en la compra')).toEqual({
      kind: 'add',
      items: ['tomates'],
    });
    expect(compraIntent('Lista de la compra: pasta, atún')).toEqual({
      kind: 'add',
      items: ['pasta', 'atún'],
    });
    expect(compraIntent('añade leche')).toBeNull();
    expect(compraIntent('añade una reunión al calendario')).toBeNull();
    expect(compraIntent('pon la tele')).toBeNull();
  });

  it('cada chat tiene su lista y el fichero está en el registro de estado', () => {
    const { file, store } = fresh('telegram:1:');
    store.add(['leche']);
    const grupo = new CompraStore(file, 'telegram:-99:7');
    expect(grupo.list()).toEqual([]);
    grupo.add(['pan']);
    expect(new CompraStore(file, 'telegram:1:topic').list().map((i) => i.text)).toEqual(['leche']);
    expect(JSON.parse(readFileSync(file, 'utf8')).lists['telegram:-99'].items[0].text).toBe('pan');
    expect(STATE_ENTRIES.some((e) => e.name === 'lista-compra.json')).toBe(true);
  });

  it('la herramienta del modelo añade, tacha y quita', async () => {
    const { store } = fresh();
    const tool = createCompraTool(store);
    const run = async (args: Parameters<typeof tool.execute>[1]) => {
      const r = await tool.execute('id', args);
      return (r.content[0] as { text: string }).text;
    };
    expect(await run({ accion: 'añadir', cosas: 'leche y pan' })).toContain(
      'Apuntado: leche, pan.',
    );
    expect(await run({ accion: 'tachar', cosas: 'el pan' })).toContain('Tachado: el pan.');
    expect(await run({ accion: 'quitar', cosas: 'leche' })).toContain('Quitado: leche.');
    expect(await run({ accion: 'ver' })).toContain('/compra');
  });

  it('itemsFromText limpia viñetas y repetidos', () => {
    expect(itemsFromText('- leche\n- pan\n• leche.')).toEqual(['leche', 'pan']);
  });

  it('sale en /help y en el menú', () => {
    expect(HELP_SECTIONS.flatMap((s) => s.entries).some((e) => e.command === 'compra')).toBe(true);
    expect(TELEGRAM_COMMANDS.some((c) => c.command === 'compra')).toBe(true);
  });
});
