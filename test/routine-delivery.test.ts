import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCronCommand } from '../src/cli.js';
import { Store } from '../src/db.js';
import {
  outputHash,
  parseDeliveryArgs,
  planDelivery,
  RoutineDeliveryStore,
  safeRoutineDirName,
  writeRoutineOutput,
} from '../src/routine-delivery.js';
import { RoutineRunner } from '../src/routines.js';

describe('planDelivery', () => {
  const chat = { target: 'chat' as const, soloSiCambia: false };
  it('por defecto entrega en el chat, como siempre', () => {
    expect(planDelivery(chat, undefined, 'hola')).toMatchObject({ chat: true, file: false });
  });
  it('solo si cambia: igual (salvo espacios) se calla, distinto se entrega', () => {
    const s = { target: 'chat' as const, soloSiCambia: true };
    const h = outputHash('Precio: 10 €\n');
    expect(planDelivery(s, h, '  Precio:   10 €')).toMatchObject({
      chat: false,
      skipped: 'sin-cambios',
    });
    expect(planDelivery(s, h, 'Precio: 9 €')).toMatchObject({ chat: true });
  });
  it('un fallo nuevo se entrega aunque el destino sea ninguno', () => {
    const s = { target: 'ninguno' as const, soloSiCambia: true };
    const body = 'No devolvió respuesta.';
    expect(planDelivery(s, undefined, body, true).chat).toBe(true);
    expect(planDelivery(s, outputHash('salida buena'), body, true).chat).toBe(true);
  });
  it('el mismo fallo seguido (p. ej. el modelo caído toda la noche) se avisa una vez, no en cada pasada', () => {
    const s = { target: 'chat' as const, soloSiCambia: false };
    const body = 'No devolvió respuesta.';
    expect(planDelivery(s, outputHash(body), body, true)).toMatchObject({
      chat: false,
      skipped: 'fallo-repetido',
    });
  });
  it('fichero y ninguno no mandan mensaje', () => {
    expect(planDelivery({ target: 'fichero', soloSiCambia: false }, undefined, 'x')).toMatchObject({
      chat: false,
      file: true,
    });
    expect(planDelivery({ target: 'ninguno', soloSiCambia: false }, undefined, 'x')).toMatchObject({
      chat: false,
      file: false,
      skipped: 'ninguno',
    });
  });
});

describe('ficheros de salida', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-delivery-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('el nombre de la rutina no puede salirse de la carpeta', () => {
    expect(safeRoutineDirName('../../etc/passwd')).toBe('etc-passwd');
    expect(safeRoutineDirName('..')).toBe('rutina');
    expect(safeRoutineDirName('Resumen del día')).toBe('Resumen-del-dia');
    const file = writeRoutineOutput(
      join(dir, 'salidas'),
      '../fuera',
      'hola',
      new Date(2026, 9, 30, 8, 5),
    );
    expect(file).toBe(join(dir, 'salidas', 'fuera', '2026-10-30.md'));
    writeRoutineOutput(join(dir, 'salidas'), '../fuera', 'adiós', new Date(2026, 9, 30, 9, 0));
    expect(readFileSync(file, 'utf8')).toBe('## 08:05\n\nhola\n\n## 09:00\n\nadiós\n\n');
  });

  it('el almacén guarda ajustes y la última huella; chat+siempre vuelve al defecto', () => {
    const store = new RoutineDeliveryStore(join(dir, 'state', 'routine-delivery.json'));
    expect(store.get('s', 'r')).toEqual({ target: 'chat', soloSiCambia: false });
    store.set('s', 'r', { target: 'fichero', soloSiCambia: true });
    store.commit('s', 'r', 'abc');
    expect(store.get('s', 'r')).toEqual({ target: 'fichero', soloSiCambia: true, lastHash: 'abc' });
    expect(store.get('otro', 'r').target).toBe('chat');
    store.set('s', 'r', { target: 'chat', soloSiCambia: false });
    expect(store.get('s', 'r')).toEqual({ target: 'chat', soloSiCambia: false });
    store.commit('s', 'r', 'zzz'); // por defecto no se guarda nada
    expect(store.get('s', 'r').lastHash).toBeUndefined();
  });

  it('un JSON roto no tumba nada', () => {
    const store = new RoutineDeliveryStore(join(dir, 'no-existe', 'x.json'));
    expect(store.get('s', 'r').target).toBe('chat');
  });
});

describe('parseDeliveryArgs', () => {
  it('opciones al final, nombre con espacios', () => {
    expect(parseDeliveryArgs('resumen del dia fichero solo-si-cambia')).toEqual({
      name: 'resumen del dia',
      setting: { target: 'fichero', soloSiCambia: true },
    });
    expect(parseDeliveryArgs('precio siempre')).toEqual({
      name: 'precio',
      setting: { soloSiCambia: false },
    });
    expect(parseDeliveryArgs('chat')).toEqual({ name: 'chat', setting: {} });
    expect(parseDeliveryArgs('')).toBeNull();
  });
});

describe('/cron entrega', () => {
  const CHAT = 'telegram:42';
  const THREAD = `${CHAT}#main`;
  let dir = '';
  let store: Store;
  let runner: RoutineRunner;
  let delivery: RoutineDeliveryStore;
  const deps = () => ({ store, routineRunner: runner, threadKey: THREAD, chatKey: CHAT, delivery });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-cron-entrega-'));
    store = new Store(join(dir, 'db.sqlite'));
    runner = new RoutineRunner({ store, run: async () => {}, timeoutMs: 5_000 });
    delivery = new RoutineDeliveryStore(join(dir, 'routine-delivery.json'));
    store.saveRoutine({
      scope: THREAD,
      name: 'precio-tv',
      kind: 'schedule',
      prompt: 'mira el precio de la tele',
      schedule: '0 9 * * *',
    });
  });
  afterEach(() => {
    runner.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('consulta, cambia y rechaza rutinas que no existen', () => {
    expect(runCronCommand(deps(), 'entrega precio-tv')).toContain('entrega en este chat');
    expect(runCronCommand(deps(), 'entrega precio-tv solo-si-cambia')).toContain(
      'entregará en este chat, solo si cambia',
    );
    expect(delivery.get(THREAD, 'precio-tv')).toMatchObject({ target: 'chat', soloSiCambia: true });
    expect(runCronCommand(deps(), 'entrega precio-tv fichero')).toContain(
      'a un fichero diario en salidas/, solo si cambia',
    );
    expect(runCronCommand(deps(), 'entrega nada-de-nada chat')).toContain('No tengo ninguna');
    expect(runCronCommand(deps(), 'entrega')).toContain('«resumen al chat, solo si cambia»');
    expect(runCronCommand(deps(), 'entrega precio-tv al chat, siempre')).toContain(
      'entregará en este chat',
    );
  });
});
