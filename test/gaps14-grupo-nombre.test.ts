import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withChatTitle } from '../src/channels/telegram.js';
import { CHAT_TITULOS_MAX, ChatTitulos, chatSinHilo, tituloLimpio } from '../src/chat-titulos.js';
import { AskFirstStore, askFirstAdd, runAskFirstCommand } from '../src/preguntar-antes.js';

describe('gaps-14: el nombre del grupo en las reglas «… en este grupo»', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-gaps14-titulos-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const GRUPO = 'telegram:default:-1001234567';
  const DM = 'telegram:default:42';

  it('el adaptador pasa chat.title solo de grupos', () => {
    expect(withChatTitle({ type: 'supergroup', title: 'Familia' })).toEqual({
      chatTitle: 'Familia',
    });
    expect(withChatTitle({ type: 'group', title: '  ' })).toEqual({});
    expect(withChatTitle({ type: 'private', first_name: 'Nico' })).toEqual({});
    expect(withChatTitle(undefined)).toEqual({});
  });

  it('guarda el nombre, lo actualiza si lo renombran y lo encuentra también desde un tema', () => {
    let t = 1_000;
    const titulos = new ChatTitulos(join(dir, 'chat-titulos.json'), () => t);
    expect(titulos.recordar(`${GRUPO}:7`, 'Inversores')).toBe(true);
    expect(titulos.nombre(GRUPO)).toBe('Inversores');
    expect(titulos.nombre(`${GRUPO}:9`)).toBe('Inversores');
    // El mismo nombre al rato no reescribe el fichero.
    t += 60_000;
    expect(titulos.recordar(GRUPO, 'Inversores')).toBe(false);
    expect(titulos.recordar(GRUPO, 'Inversores 2026')).toBe(true);
    // Otro proceso (tras /actualizar) lo lee del fichero.
    expect(new ChatTitulos(join(dir, 'chat-titulos.json')).nombre(GRUPO)).toBe('Inversores 2026');
    expect(titulos.nombre('telegram:default:-999')).toBeUndefined();
    expect(chatSinHilo(`${GRUPO}:7`)).toBe(GRUPO);
  });

  it('limpia el nombre: sin saltos, sin «», recortado', () => {
    expect(tituloLimpio('Fa\nmi\u202elia  «X»')).toBe('Fa mi lia "X"');
    expect(tituloLimpio('a'.repeat(100))).toHaveLength(60);
    expect(tituloLimpio('\u0000')).toBe('');
    expect(tituloLimpio(undefined)).toBe('');
  });

  it('no crece sin tope', () => {
    let t = 0;
    const file = join(dir, 'chat-titulos.json');
    const titulos = new ChatTitulos(file, () => ++t);
    for (let i = 0; i < CHAT_TITULOS_MAX + 5; i++)
      titulos.recordar(`telegram:default:-${i + 1}`, `G${i}`);
    const datos = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(datos)).toHaveLength(CHAT_TITULOS_MAX);
    expect(titulos.nombre('telegram:default:-1')).toBeUndefined();
    expect(titulos.nombre(`telegram:default:-${CHAT_TITULOS_MAX + 5}`)).toBe(
      `G${CHAT_TITULOS_MAX + 4}`,
    );
  });

  it('la lista desde el privado dice el grupo por su nombre', () => {
    const store = new AskFirstStore(join(dir, 'preguntar-antes.json'));
    const titulos = new ChatTitulos(join(dir, 'chat-titulos.json'));
    titulos.recordar(GRUPO, 'Familia');
    askFirstAdd(store, 'tocar la tele', { chat: GRUPO, group: true });
    askFirstAdd(store, 'usar el navegador', { chat: 'telegram:default:-555', group: true });
    const lista = runAskFirstCommand(store, 'lista', {
      chat: DM,
      group: false,
      nombreDe: (c) => titulos.nombre(c),
    });
    expect(lista).toContain('(solo en el grupo «Familia»)');
    // Un grupo del que aún no sé el nombre: como antes.
    expect(lista).toContain('(solo en un grupo)');
    // Sin la búsqueda de nombres: igual que hasta ahora.
    expect(runAskFirstCommand(store, 'lista', { chat: DM, group: false })).not.toContain('Familia');
    // Desde el propio grupo sigue diciendo «en este grupo».
    expect(
      runAskFirstCommand(store, 'lista', {
        chat: GRUPO,
        group: true,
        nombreDe: (c) => titulos.nombre(c),
      }),
    ).toContain('(solo en este grupo)');
  });
});
