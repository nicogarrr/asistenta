// bugs-36 (revisión de #2337): en un grupo con temas (foro) la clave del chat lleva el tema
// («telegram:cuenta:-100222:7»). Una regla «pregúntame antes de … en este grupo» dicha en un
// tema solo valía en ESE tema: en «General» o en otro tema no preguntaba, y desde allí la
// lista ni la enseñaba.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AskFirstStore, askFirstAdd, runAskFirstCommand } from '../src/preguntar-antes.js';

const TEMA_7 = 'telegram:default:-100222:7';
const TEMA_3 = 'telegram:default:-100222:3';
const GENERAL = 'telegram:default:-100222';
const OTRO_GRUPO = 'telegram:default:-100333:7';
const click = { tool: 'browser', args: { action: 'click' } };

describe('reglas «… en este grupo» en un grupo con temas', () => {
  let dir = '';
  let store: AskFirstStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-bugs36-temas-'));
    store = new AskFirstStore(join(dir, 'preguntar-antes.json'), () => Date.UTC(2026, 10, 11, 16));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('dicha en un tema vale en todo el grupo (otros temas y General), no en otro grupo', () => {
    const r = askFirstAdd(store, 'usar el navegador', { chat: TEMA_7, group: true });
    expect(r).toContain('en este grupo');
    expect(store.reasonFor(click, TEMA_7)).not.toBeNull();
    expect(store.reasonFor(click, TEMA_3)).not.toBeNull();
    expect(store.reasonFor(click, GENERAL)).not.toBeNull();
    expect(store.reasonFor(click, OTRO_GRUPO)).toBeNull();
  });

  it('desde otro tema la lista la enseña como de este grupo, y repetirla dice que ya estaba', () => {
    askFirstAdd(store, 'usar el navegador', { chat: TEMA_7, group: true });
    const lista = runAskFirstCommand(store, 'lista', { chat: TEMA_3, group: true });
    expect(lista).toContain('(solo en este grupo)');
    askFirstAdd(store, 'usar el navegador', { chat: TEMA_3, group: true });
    expect(store.list()).toHaveLength(1);
  });

  it('una regla ya guardada con el tema (de antes) también vale en el resto del grupo', () => {
    store.add('usar el navegador', TEMA_7);
    expect(store.reasonFor(click, TEMA_3)).not.toBeNull();
  });
});
