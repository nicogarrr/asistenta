import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoutineFire } from '../src/daemon/routine-fire.js';
import { type Routine, Store } from '../src/db.js';
import { createReminderTool, reminderEnded, untilOfReminder } from '../src/tools/reminder.js';

// Lunes 5 de octubre de 2026, 10:00 hora local.
const NOW = new Date(2026, 9, 5, 10, 0, 0).getTime();
let dir = '';
let store: Store;

async function run(args: Record<string, unknown>) {
  const tool = createReminderTool({
    store,
    scopeOf: () => 'tg:1:2',
    sync: () => {},
    now: () => NOW,
  });
  const res = await tool.execute('id', args as never);
  const first = res.content[0];
  return { text: first && first.type === 'text' ? first.text : '', isError: res.isError === true };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rem-hasta-'));
  store = new Store(join(dir, 'db.sqlite'));
});
afterEach(() => {
  store.close?.();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('recordatorios que se repiten con último día (until)', () => {
  it('«cada día a las 9 hasta el viernes» guarda el último día y lo dice', async () => {
    const r = await run({
      action: 'create',
      text: 'tomar la pastilla',
      schedule: '0 9 * * *',
      until: '2026-10-09',
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('hasta 2026-10-09');
    const [saved] = store.listRoutines('tg:1:2');
    expect(untilOfReminder(saved?.name ?? '')).toBe('2026-10-09');
    const list = await run({ action: 'list' });
    expect(list.text).toContain('hasta 2026-10-09');
  });

  it('rechaza until sin schedule, con fecha mala, pasada o sin ninguna vez antes', async () => {
    expect(
      (await run({ action: 'create', text: 'x', in_minutes: 10, until: '2026-10-09' })).isError,
    ).toBe(true);
    expect(
      (await run({ action: 'create', text: 'x', schedule: '0 9 * * *', until: '9/10' })).isError,
    ).toBe(true);
    expect(
      (await run({ action: 'create', text: 'x', schedule: '0 9 * * *', until: '2026-02-30' }))
        .isError,
    ).toBe(true);
    expect(
      (await run({ action: 'create', text: 'x', schedule: '0 9 * * *', until: '2026-10-04' }))
        .isError,
    ).toBe(true);
    // Solo los lunes a las 9: hoy lunes ya pasó la hora y el siguiente es el 12.
    expect(
      (await run({ action: 'create', text: 'x', schedule: '0 9 * * 1', until: '2026-10-11' }))
        .isError,
    ).toBe(true);
    expect(store.listRoutines('tg:1:2')).toHaveLength(0);
  });

  it('sin until sigue igual que antes (no acaba nunca)', async () => {
    await run({ action: 'create', text: 'regar', schedule: '0 9 * * *' });
    const [saved] = store.listRoutines('tg:1:2');
    expect(untilOfReminder(saved?.name ?? '')).toBeNull();
    expect(reminderEnded(saved as Routine, new Date(2030, 0, 1), true)).toBe(false);
  });
});

const rem = (name: string): Routine => ({
  id: 'r1',
  scope: 'telegram:dm:42',
  name,
  kind: 'schedule',
  params: null,
  steps: null,
  prompt: 'tomar la pastilla',
  schedule: '0 9 * * *',
  enabled: true,
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z',
  lastRunAt: null,
});

function fireDeps(deleteRoutine = vi.fn(() => true)) {
  return {
    store: { deleteRoutine } as unknown as Store,
    tickGoal: vi.fn(async () => {}),
    runTask: vi.fn(async () => 'hecho'),
    send: vi.fn(async () => ({})),
    delivery: {
      get: () => ({ target: 'chat' as const, soloSiCambia: false }),
      commit: vi.fn(),
    } as never,
    outputDir: '/nonexistent/salidas',
    sync: vi.fn(),
    droppedRemindersPath: '/nonexistent/dropped.jsonl',
  };
}

describe('disparo de un recordatorio con último día', () => {
  it('pasado su último día ya no avisa y se borra', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 10, 9, 0));
    const d = fireDeps();
    const r = rem('recordatorio: tomar la pastilla [0 9 * * *] hasta 2026-10-09');
    await createRoutineFire(d)('meta', { scope: r.scope, routine: r });
    expect(d.send).not.toHaveBeenCalled();
    expect(d.store.deleteRoutine).toHaveBeenCalledWith(r.scope, r.name);
  });

  it('el último día avisa y después se borra; antes de ese día no se borra', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 9, 9, 0));
    const last = fireDeps();
    const r = rem('recordatorio: tomar la pastilla [0 9 * * *] hasta 2026-10-09');
    await createRoutineFire(last)('meta', { scope: r.scope, routine: r });
    expect(last.send).toHaveBeenCalledTimes(1);
    expect(last.store.deleteRoutine).toHaveBeenCalledWith(r.scope, r.name);

    vi.setSystemTime(new Date(2026, 9, 7, 9, 0));
    const mid = fireDeps();
    await createRoutineFire(mid)('meta', { scope: r.scope, routine: r });
    expect(mid.send).toHaveBeenCalledTimes(1);
    expect(mid.store.deleteRoutine).not.toHaveBeenCalled();
  });
});
