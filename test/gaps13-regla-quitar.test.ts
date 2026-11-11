import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AskFirstStore, askFirstFromText, runAskFirstCommand } from '../src/preguntar-antes.js';

describe('gaps-13: la pregunta de una regla «pregúntame antes» dice cómo quitarla (Grok «Edit rule»)', () => {
  let dir = '';
  let store: AskFirstStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-gaps13-regla-'));
    store = new AskFirstStore(join(dir, 'preguntar-antes.json'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('nombra la regla que la hizo saltar con su número, y ese número la quita', () => {
    askFirstFromText(store, 'pregúntame antes de ejecutar comandos');
    askFirstFromText(store, 'pregúntame antes de tocar la tele');
    const why = store.reasonFor({ tool: 'tv', args: { action: 'key' } });
    expect(why).toContain('(«tocar la tele»)');
    expect(why).toContain('Si ya no quieres que te lo pregunte: /permisos preguntar quitar 2.');
    expect(runAskFirstCommand(store, 'quitar 2')).toContain('ya no te pregunto de más');
    expect(store.reasonFor({ tool: 'tv', args: { action: 'key' } })).toBeNull();
    expect(store.reasonFor({ tool: 'shell', args: { command: 'dir' } })).toContain('quitar 1');
  });
});
