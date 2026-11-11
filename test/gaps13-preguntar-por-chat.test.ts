import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AskFirstStore,
  askFirstFromText,
  runAskFirstCommand,
  splitAskFirstScope,
} from '../src/preguntar-antes.js';

const DM = 'telegram:default:111';
const GRUPO = 'telegram:default:-100222';
const OTRO_GRUPO = 'telegram:default:-100333';
const click = { tool: 'browser', args: { action: 'click' } };
const tele = { tool: 'tv', args: { action: 'key' } };

describe('gaps-13: reglas «pregúntame antes de …» por chat', () => {
  let dir = '';
  let store: AskFirstStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-gaps13-preguntar-'));
    store = new AskFirstStore(join(dir, 'preguntar-antes.json'), () => Date.UTC(2026, 10, 11, 15));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('separa dónde vale de lo que es', () => {
    expect(splitAskFirstScope('usar el navegador en este grupo')).toEqual({
      what: 'usar el navegador',
      where: 'aqui',
    });
    expect(splitAskFirstScope('tocar la tele solo aquí.')).toEqual({
      what: 'tocar la tele',
      where: 'aqui',
    });
    expect(splitAskFirstScope('tocar la tele en todos los chats')).toEqual({
      what: 'tocar la tele',
      where: 'todos',
    });
    expect(splitAskFirstScope('mandar correos')).toEqual({ what: 'mandar correos', where: null });
  });

  it('dicha en un grupo vale solo en ese grupo; las demás conversaciones no preguntan de más', () => {
    const r = askFirstFromText(store, 'pregúntame antes de tocar la tele', {
      chat: GRUPO,
      group: true,
    });
    expect(r).toContain('en este grupo');
    expect(store.reasonFor(tele, GRUPO)).toContain('en este chat');
    expect(store.reasonFor(tele, DM)).toBeNull();
    expect(store.reasonFor(tele, OTRO_GRUPO)).toBeNull();
    expect(store.reasonFor(tele)).toBeNull();
  });

  it('«… en todos los chats» desde un grupo, o dicha en privado, vale en todos los hilos (como antes)', () => {
    askFirstFromText(store, 'pregúntame antes de tocar la tele en todos los chats', {
      chat: GRUPO,
      group: true,
    });
    askFirstFromText(store, 'pregúntame antes de usar el navegador', { chat: DM, group: false });
    for (const chat of [DM, GRUPO, OTRO_GRUPO, undefined]) {
      expect(store.reasonFor(tele, chat)).not.toBeNull();
      expect(store.reasonFor(click, chat)).not.toBeNull();
    }
    // Sin chat (como en gaps-12) sigue siendo de todos los hilos.
    expect(runAskFirstCommand(store, 'ejecutar comandos')).toContain('✅ Hecho');
    expect(store.reasonFor({ tool: 'shell', args: { command: 'dir' } }, GRUPO)).not.toBeNull();
  });

  it('«… solo aquí» en privado no salpica a los grupos', () => {
    const r = runAskFirstCommand(store, 'usar el navegador solo aquí', { chat: DM, group: false });
    expect(r).toContain('en este chat');
    expect(store.reasonFor(click, DM)).not.toBeNull();
    expect(store.reasonFor(click, GRUPO)).toBeNull();
  });

  it('una de todos los hilos cubre la del chat; ponerla de todos quita las de un chat', () => {
    askFirstFromText(store, 'pregúntame antes de tocar la tele', { chat: GRUPO, group: true });
    expect(
      askFirstFromText(store, 'pregúntame antes de tocar la tele aquí', {
        chat: GRUPO,
        group: true,
      }),
    ).toContain('Ya te lo preguntaba');
    askFirstFromText(store, 'pregúntame antes de tocar la tele', { chat: DM, group: false });
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.chat).toBeUndefined();
    expect(
      askFirstFromText(store, 'pregúntame antes de tocar la tele en este grupo', {
        chat: OTRO_GRUPO,
        group: true,
      }),
    ).toContain('Ya te lo preguntaba');
  });

  it('la lista dice dónde vale cada una; desde un grupo no se ven ni se quitan las de otro', () => {
    askFirstFromText(store, 'pregúntame antes de tocar la tele', { chat: GRUPO, group: true });
    askFirstFromText(store, 'pregúntame antes de poner música', { chat: OTRO_GRUPO, group: true });
    askFirstFromText(store, 'pregúntame antes de usar el navegador', { chat: DM, group: false });
    const enPrivado = runAskFirstCommand(store, 'lista', { chat: DM, group: false });
    expect(enPrivado).toContain('(3)');
    expect(enPrivado).toContain('tocar la tele (solo en un grupo)');
    const enGrupo = runAskFirstCommand(store, 'lista', { chat: GRUPO, group: true });
    expect(enGrupo).toContain('(2)');
    expect(enGrupo).toContain('tocar la tele (solo en este grupo)');
    expect(enGrupo).not.toContain('música');
    runAskFirstCommand(store, 'quitar todo', { chat: GRUPO, group: true });
    expect(store.list().map((r) => r.area)).toEqual(['musica']);
  });

  it('se guarda el chat en disco y un fichero de gaps-12 (sin chat) sigue valiendo en todos', () => {
    askFirstFromText(store, 'pregúntame antes de tocar la tele', { chat: GRUPO, group: true });
    const raw = JSON.parse(readFileSync(join(dir, 'preguntar-antes.json'), 'utf8'));
    expect(raw[0].chat).toBe(GRUPO);
    const again = new AskFirstStore(join(dir, 'preguntar-antes.json'));
    expect(again.reasonFor(tele, GRUPO)).not.toBeNull();
    expect(again.reasonFor(tele, DM)).toBeNull();
  });

  it('cli: el hilo pasa su chat, y en un grupo solo el dueño pone reglas', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toContain('askFirst.reasonFor(call, chatKey_)');
    const i = cli.indexOf('dicho por el dueño en un grupo');
    expect(i).toBeGreaterThan(0);
    const bloque = cli.slice(i, i + 700);
    expect(bloque).toContain('inbound.isGroup');
    expect(bloque).toContain('inbound.userId === String(vigilanteOwnerId)');
    expect(bloque).toContain('group: true');
  });
});
