import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_WATCHES, WatchRegistry } from '../src/watch/registry.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const T0 = 1_760_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const dirs: string[] = [];

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pa-watch-registry-'));
  dirs.push(dir);
  return join(dir, 'watch', 'registry.json');
}

function make(file = tempFile(), now = () => T0, max?: number): WatchRegistry {
  return new WatchRegistry({ file, now, ...(max === undefined ? {} : { max }) });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('WatchRegistry add/list', () => {
  it('añade, rellena defaults y persiste un único JSON', () => {
    const file = tempFile();
    const registry = make(file);
    const watch = registry.add({
      kind: 'page',
      target: 'https://ejemplo.test/piso',
      chatId: 'chat-1',
      threadId: 'tema-1',
      note: 'piso  de   prueba',
      schedule: '1h',
    });

    expect(watch).toMatchObject({
      kind: 'page',
      target: 'https://ejemplo.test/piso',
      chatId: 'chat-1',
      threadId: 'tema-1',
      note: 'piso de prueba',
      schedule: '1h',
      enabled: true,
      createdAt: T0,
    });
    expect(watch.id).toMatch(/^[0-9a-f-]{36}$/);

    const stored = JSON.parse(readFileSync(file, 'utf8')) as unknown[];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: watch.id, target: watch.target });

    const reloaded = make(file);
    expect(reloaded.list()).toEqual([watch]);
  });

  it('filtra por chat, hilo, tipo y estado', () => {
    const registry = make();
    const page = registry.add({ kind: 'page', target: 'a', chatId: 'c1' });
    const price = registry.add({ kind: 'price', target: 'b', chatId: 'c1', threadId: 'h1' });
    registry.add({ kind: 'inbox', target: 'c', chatId: 'c2', enabled: false });

    expect(registry.list({ chatId: 'c1' }).map((w) => w.id)).toEqual([page.id, price.id]);
    expect(registry.list({ kind: 'price' }).map((w) => w.id)).toEqual([price.id]);
    expect(registry.list({ threadId: 'h1' }).map((w) => w.id)).toEqual([price.id]);
    expect(registry.list({ enabled: false })).toHaveLength(1);
    expect(registry.list()).toHaveLength(3);
  });

  it('no duplica la misma vigilancia: la reconfigura', () => {
    const registry = make();
    const first = registry.add({ kind: 'page', target: 'https://ejemplo.test/x', chatId: 'c' });
    const second = registry.add({
      kind: 'page',
      target: 'https://ejemplo.test/x',
      chatId: 'c',
      note: 'nueva nota',
      schedule: '15m',
    });

    expect(second.id).toBe(first.id);
    expect(second.note).toBe('nueva nota');
    expect(second.schedule).toBe('15m');
    expect(registry.list()).toHaveLength(1);
  });

  it('actualizar por id conserva lo que no se especifica', () => {
    const registry = make();
    const watch = registry.add({
      id: 'vigilancia-1',
      kind: 'file',
      target: 'C:\\datos',
      chatId: 'c',
      schedule: 'daily',
      note: 'original',
    });
    const updated = registry.add({
      id: watch.id,
      kind: 'file',
      target: 'C:\\datos',
      chatId: 'c',
      note: 'cambiada',
    });

    expect(updated.schedule).toBe('daily');
    expect(updated.note).toBe('cambiada');
    expect(registry.list()).toHaveLength(1);
  });

  it('rechaza tipos, targets y cadencias inválidas', () => {
    const registry = make();
    expect(() => registry.add({ kind: 'otro' as 'page', target: 'x', chatId: 'c' })).toThrow(
      /kind/,
    );
    expect(() => registry.add({ kind: 'page', target: '   ', chatId: 'c' })).toThrow(/target/);
    expect(() => registry.add({ kind: 'page', target: 'x', chatId: ' ' })).toThrow(/chatId/);
    expect(() =>
      registry.add({
        kind: 'page',
        target: 'x',
        chatId: 'c',
        schedule: '2h' as '1h',
      }),
    ).toThrow(/schedule/);
  });

  it('remove borra solo el id pedido y devuelve si existía', () => {
    const registry = make();
    const keeper = registry.add({ kind: 'page', target: 'a', chatId: 'c' });
    const doomed = registry.add({ kind: 'price', target: 'b', chatId: 'c' });

    expect(registry.remove('no-existe')).toBe(false);
    expect(registry.remove(doomed.id)).toBe(true);
    expect(registry.list().map((w) => w.id)).toEqual([keeper.id]);
  });

  it('respeta el tope y no deja temporales detrás', () => {
    const file = tempFile();
    const registry = make(file, () => T0, 2);
    registry.add({ kind: 'page', target: 'a', chatId: 'c' });
    registry.add({ kind: 'page', target: 'b', chatId: 'c' });
    expect(() => registry.add({ kind: 'page', target: 'c', chatId: 'c' })).toThrow(/2/);
    expect(MAX_WATCHES).toBe(200);
    expect(readdirSync(dirname(file)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('aparta un JSON corrupto en vez de sobrescribirlo', () => {
    const file = tempFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ esto no es json', 'utf8');

    const registry = make(file);
    expect(registry.list()).toEqual([]);
    expect(readdirSync(dirname(file))).toContainEqual(expect.stringContaining('.corrupt-'));
  });
});

describe('WatchRegistry markRun/dueForPush', () => {
  it('sin schedule es manual: nunca vence sola', () => {
    const registry = make();
    registry.add({ kind: 'page', target: 'manual', chatId: 'c' });
    expect(registry.dueForPush(T0 + 365 * 24 * HOUR)).toEqual([]);
  });

  it('sin lastRun vence en el acto; con lastRun respeta la cadencia', () => {
    const registry = make();
    const fifteen = registry.add({ kind: 'price', target: 'p15', chatId: 'c', schedule: '15m' });
    const hourly = registry.add({ kind: 'inbox', target: 'p1h', chatId: 'c', schedule: '1h' });
    const six = registry.add({ kind: 'calendar', target: 'p6h', chatId: 'c', schedule: '6h' });
    const daily = registry.add({ kind: 'file', target: 'pd', chatId: 'c', schedule: 'daily' });

    expect(
      registry
        .dueForPush(T0)
        .map((w) => w.id)
        .sort(),
    ).toEqual([fifteen.id, hourly.id, six.id, daily.id].sort());

    registry.markRun(fifteen.id, T0);
    expect(registry.dueForPush(T0 + 14 * MINUTE).map((w) => w.id)).not.toContain(fifteen.id);
    expect(registry.dueForPush(T0 + 15 * MINUTE).map((w) => w.id)).toContain(fifteen.id);
  });

  it('markRun actualiza lastRunMs y persiste; un id inexistente no cambia nada', () => {
    const file = tempFile();
    const registry = make(file);
    const watch = registry.add({ kind: 'page', target: 'a', chatId: 'c', schedule: '1h' });

    expect(registry.markRun('no-existe', T0)).toBe(false);
    expect(registry.markRun(watch.id, T0 + 5 * MINUTE)).toBe(true);
    expect(make(file).list()[0]?.lastRunMs).toBe(T0 + 5 * MINUTE);
    expect(() => registry.markRun(watch.id, Number.NaN)).toThrow(/instante/);
  });

  it('omite las deshabilitadas aunque su cadencia haya vencido', () => {
    const registry = make();
    registry.add({
      kind: 'page',
      target: 'a',
      chatId: 'c',
      schedule: '15m',
      enabled: false,
    });
    expect(registry.dueForPush(T0 + HOUR)).toEqual([]);
  });
});
