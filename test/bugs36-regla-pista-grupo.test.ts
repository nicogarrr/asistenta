import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AskFirstStore, askFirstFromText } from '../src/preguntar-antes.js';

// bugs-36 (lead de bugs-35, revisión de #2343): la pregunta de una regla decía «Si ya no
// quieres que te lo pregunte: /permisos preguntar quitar N» también en un grupo, donde
// /permisos contesta «Este comando solo funciona en el chat privado del dueño».

describe('la pista para quitar una regla dice dónde funciona /permisos', () => {
  let dir = '';
  let store: AskFirstStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-bugs36-pista-'));
    store = new AskFirstStore(join(dir, 'preguntar-antes.json'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('en un grupo, manda al chat privado', () => {
    const grupo = 'telegram:main:-100123';
    askFirstFromText(store, 'pregúntame antes de tocar la tele', { chat: grupo, group: true });
    const why = store.reasonFor({ tool: 'tv', args: { action: 'key' } }, grupo);
    expect(why).toContain('/permisos preguntar quitar 1');
    expect(why).toContain('en mi chat privado');
  });

  it('una regla de todos los chats que salta en un grupo, también', () => {
    askFirstFromText(store, 'pregúntame antes de tocar la tele');
    const why = store.reasonFor({ tool: 'tv', args: { action: 'key' } }, 'telegram:main:-100999:7');
    expect(why).toContain('en mi chat privado');
  });

  it('en el privado sigue igual', () => {
    askFirstFromText(store, 'pregúntame antes de tocar la tele');
    const why = store.reasonFor({ tool: 'tv', args: { action: 'key' } }, 'telegram:main:555');
    expect(why).toContain('Si ya no quieres que te lo pregunte: /permisos preguntar quitar 1.');
    expect(why).not.toContain('privado');
    expect(store.reasonFor({ tool: 'tv', args: { action: 'key' } })).not.toContain('privado');
  });
});
