import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMAND_PROMPT_PREFIX } from '../src/command-routine.js';
import { createRoutineFire } from '../src/daemon/routine-fire.js';
import type { Routine, Store } from '../src/db.js';
import { RoutineDeliveryStore } from '../src/routine-delivery.js';

const SCOPE = 'telegram:dm:42#main';
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-cmd-err-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const routine = (): Routine => ({
  id: 'r1',
  scope: SCOPE,
  name: 'saldo',
  kind: 'schedule',
  params: null,
  steps: null,
  prompt: `${COMMAND_PROMPT_PREFIX}saldo.exe`,
  schedule: '0 8 * * *',
  enabled: true,
  createdAt: '2026-10-30T08:00:00.000Z',
  updatedAt: '2026-10-30T08:00:00.000Z',
  lastRunAt: null,
});

async function fireWith(err: Error): Promise<string> {
  const send = vi.fn(async (_chatId: string, _text: string) => ({}));
  await createRoutineFire({
    store: {} as Store,
    tickGoal: vi.fn(async () => {}),
    runTask: vi.fn(async (): Promise<string> => ''),
    send,
    delivery: new RoutineDeliveryStore(join(dir, 'delivery.json')),
    outputDir: join(dir, 'salidas'),
    sync: vi.fn(),
    droppedRemindersPath: join(dir, 'dropped.jsonl'),
    fireCommand: vi.fn(async () => {
      throw err;
    }),
  })('meta', { scope: SCOPE, routine: routine() });
  expect(send).toHaveBeenCalledTimes(1);
  return String(send.mock.calls[0]?.[1]);
}

describe('rutina de comando que no llega a ejecutarse: el aviso va en castellano', () => {
  it('programa que no existe: sin «Error:», ENOENT ni ruta', async () => {
    const e = Object.assign(new Error('spawn C:\\Herramientas\\saldo.exe ENOENT'), {
      code: 'ENOENT',
    });
    const text = await fireWith(e);
    expect(text).toContain('No se pudo ejecutar el comando: no encuentro el programa.');
    expect(text).not.toMatch(/Error:|ENOENT|spawn|Herramientas/);
  });

  it('sin permiso', async () => {
    const text = await fireWith(Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }));
    expect(text).toContain('no tengo permiso para ejecutarlo');
    expect(text).not.toMatch(/EACCES|spawn/);
  });

  it('cualquier otro fallo no enseña el texto en inglés', async () => {
    const text = await fireWith(new TypeError("Cannot read properties of undefined (reading 'x')"));
    expect(text).toContain('fallo interno');
    expect(text).not.toMatch(/Cannot read|undefined/);
  });
});
