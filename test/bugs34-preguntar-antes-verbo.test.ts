import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AskFirstStore, askFirstFromText } from '../src/preguntar-antes.js';

// bugs-34 (sobre #2318): «pregúntame antes de borrar archivos» se pasaba a
// runAskFirstCommand, que miraba la primera palabra («borrar») como el subcomando
// /permisos preguntar borrar: en vez de PONER la regla, la QUITABA (o decía «No tengo esa
// regla»). «Pregúntame antes de ver la tele» enseñaba la lista. Una regla de seguridad que
// Nico pide hablando no se puede quedar sin poner.

describe('«pregúntame antes de <verbo> …» dicho hablando siempre añade', () => {
  let dir = '';
  let store: AskFirstStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-bugs34-preguntar-'));
    store = new AskFirstStore(join(dir, 'preguntar-antes.json'), () => Date.UTC(2026, 10, 11, 14));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('«borrar archivos», «quitar canciones», «ver la tele»: se apuntan', () => {
    expect(askFirstFromText(store, 'Pregúntame antes de borrar archivos.')).toContain('✅');
    expect(
      askFirstFromText(store, 'pídeme permiso antes de quitar canciones de Spotify'),
    ).toContain('✅');
    expect(askFirstFromText(store, 'pregúntame antes de ver la tele')).toContain('✅');
    expect(store.list().map((r) => r.area)).toEqual(['archivos', 'musica', 'tele']);
    expect(store.reasonFor({ tool: 'write', args: {} })).toContain('borrar archivos');
  });

  it('con la regla ya puesta, decirlo otra vez no la quita', () => {
    askFirstFromText(store, 'pregúntame antes de escribir archivos');
    expect(askFirstFromText(store, 'pregúntame antes de borrar archivos')).toContain('Ya te lo');
    expect(store.list()).toHaveLength(1);
  });

  it('lo que no es una regla sigue al modelo', () => {
    expect(askFirstFromText(store, 'pregúntame qué tal el día')).toBeNull();
    expect(askFirstFromText(store, 'pregúntame antes de hacer la cena')).toBeNull();
  });
});
