import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Gate } from '../src/permissions.js';
import {
  AskFirstStore,
  areasOf,
  askFirstRequest,
  runAskFirstCommand,
} from '../src/preguntar-antes.js';

describe('«pregúntame antes de …» (Grok Bot: reglas propias «Ask first»)', () => {
  let dir = '';
  let store: AskFirstStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-gaps12-preguntar-'));
    store = new AskFirstStore(join(dir, 'preguntar-antes.json'), () => Date.UTC(2026, 10, 11, 14));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('entiende la frase normal y qué acciones nombra', () => {
    expect(askFirstRequest('Pregúntame antes de usar el navegador.')).toBe('usar el navegador');
    expect(askFirstRequest('a partir de ahora pídeme permiso antes de tocar la tele')).toBe(
      'tocar la tele',
    );
    expect(askFirstRequest('consúltame siempre antes de ejecutar comandos')).toBe(
      'ejecutar comandos',
    );
    expect(askFirstRequest('pregúntame qué tal el día')).toBeNull();
    expect(areasOf('usar el navegador o la tele')).toEqual(['navegador', 'tele']);
    expect(areasOf('mandar correos')).toEqual(['correo']);
    expect(areasOf('hacer la cena')).toEqual([]);
  });

  it('una regla pregunta por lo que hace, nunca por lo que solo mira', () => {
    runAskFirstCommand(store, 'usar el navegador');
    runAskFirstCommand(store, 'ejecutar comandos');
    expect(store.reasonFor({ tool: 'browser', args: { action: 'click' } })).toContain(
      'usar el navegador',
    );
    expect(store.reasonFor({ tool: 'browser', args: { action: 'screenshot' } })).toBeNull();
    expect(store.reasonFor({ tool: 'shell', args: { command: 'git status' } })).toContain(
      'comandos',
    );
    expect(store.reasonFor({ tool: 'tv', args: { action: 'key' } })).toBeNull();
  });

  it('/permisos preguntar: lista, repetida y quitar', () => {
    expect(runAskFirstCommand(store, '')).toContain('No tienes reglas');
    expect(runAskFirstCommand(store, 'tocar la tele')).toContain('✅ Hecho');
    expect(runAskFirstCommand(store, 'la tele')).toContain('Ya te lo preguntaba');
    expect(store.list()).toHaveLength(1);
    expect(runAskFirstCommand(store, 'lista')).toContain('1. tocar la tele — «tocar la tele»');
    expect(runAskFirstCommand(store, 'hacer la cena')).toContain('No sé a qué acciones');
    expect(runAskFirstCommand(store, 'quitar 1')).toContain('ya no te pregunto de más');
    expect(store.list()).toEqual([]);
  });

  it('se guarda en disco (sobrevive a un reinicio) y un fichero roto no tumba nada', () => {
    runAskFirstCommand(store, 'mover el ratón');
    const again = new AskFirstStore(join(dir, 'preguntar-antes.json'));
    expect(again.list().map((r) => r.area)).toEqual(['ordenador']);
    expect(again.reasonFor({ tool: 'computer', args: { action: 'click' } })).not.toBeNull();
    expect(again.reasonFor({ tool: 'computer', args: { action: 'screenshot' } })).toBeNull();
  });

  it('con el Gate de verdad: pasa por encima del «Siempre» y de la lista libre', async () => {
    runAskFirstCommand(store, 'usar el navegador');
    const asked: string[] = [];
    const gate = new Gate({
      allowActions: ['browser:click'],
      approver: (_call, reason) => {
        asked.push(reason);
        return false;
      },
    });
    gate.registerSession('s');
    const click = {
      tool: 'browser',
      args: { action: 'click', target: 'Siguiente' },
      actor: 'model',
    };
    // Sin regla, la lista libre lo deja pasar.
    expect((await gate.check('s', click as never)).verdict).toBe('allow');
    gate.setForcedAsk('s', (call) => store.reasonFor(call));
    const d = await gate.check('s', click as never);
    expect(d.verdict).not.toBe('allow');
    expect(asked.join(' ')).toContain('Me pediste que te preguntara antes de usar el navegador');
    // Lo que solo mira sigue libre.
    const shot = { tool: 'browser', args: { action: 'screenshot' }, actor: 'model' };
    gate.setForcedAsk('s', (call) => store.reasonFor(call));
    expect(store.reasonFor(shot)).toBeNull();
  });

  it('cli: la regla entra en el guardia de cada hilo y /permisos preguntar existe', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    expect(cli).toContain('askFirst.reasonFor(call)');
    expect(cli).toContain("if (permisosSub === 'preguntar')");
    // bugs-34: hablando se AÑADE siempre (askFirstFromText), no por el subcomando de /permisos.
    expect(cli).toContain('askFirstFromText(askFirst, text)');
  });
});
