import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CompraStore,
  compraIntent,
  compraPress,
  createCompraTool,
  runCompraIntent,
} from '../src/compra.js';

/** Lista de la compra: en texto para copiar/reenviar y «vacía lo tachado». */
const dirs: string[] = [];
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-tg27-compra-'));
  dirs.push(dir);
  const store = new CompraStore(join(dir, 'lista-compra.json'), 'telegram:7');
  store.add(['leche', 'pan', '6 huevos']);
  store.mark('pan', true);
  return store;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('la lista en texto para copiar o reenviar', () => {
  it.each([
    'pásame la lista para copiar',
    'la lista de la compra en texto',
    'comparte la lista de la compra',
    'mándame la lista para reenviar',
  ])('%s', (text) => {
    expect(compraIntent(text)).toEqual({ kind: 'text' });
  });

  it('solo lo que falta, una cosa por línea, sin casillas', () => {
    const store = fresh();
    const view = runCompraIntent(store, { kind: 'text' });
    expect(view.text).toBe('Lista de la compra:\n- leche\n- 6 huevos');
    expect(view.text).not.toContain('⬜');
  });

  it('el botón «📋 En texto» cambia el mensaje y «↩️ Volver» trae los botones de tachar', () => {
    const store = fresh();
    const list = runCompraIntent(store, { kind: 'show' });
    const texto = list.buttons.find((b) => b.label === '📋 En texto');
    expect(texto).toBeDefined();
    const plain = compraPress(store, texto?.action ?? '');
    expect(plain.text).toBe('Lista de la compra:\n- leche\n- 6 huevos');
    const back = compraPress(store, plain.buttons[0]?.action ?? '');
    expect(back.text).toContain('2 por comprar');
  });

  it('la herramienta del modelo también la da en texto', async () => {
    const tool = createCompraTool(fresh());
    const r = await tool.execute('i', { accion: 'texto' });
    expect((r.content[0] as { text: string }).text).toBe(
      'Lista de la compra:\n- leche\n- 6 huevos',
    );
  });
});

describe('«vacía lo tachado»', () => {
  it.each([
    'vacía lo tachado',
    'quítame lo comprado de la lista',
    'borra lo que ya he comprado',
    'saca los tachados de la lista de la compra',
  ])('%s', (text) => {
    expect(compraIntent(text)).toEqual({ kind: 'clearDone' });
  });
  it('quita lo tachado y deja lo que falta', () => {
    const store = fresh();
    const view = runCompraIntent(store, compraIntent('vacía lo tachado') ?? { kind: 'show' });
    expect(view.text).toContain('Quitadas 1 tachadas.');
    expect(store.list().map((i) => i.text)).toEqual(['leche', '6 huevos']);
  });
});
