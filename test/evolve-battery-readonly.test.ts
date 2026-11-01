import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import { INERT_TOOLS, WORKSPACE_TOOLS } from '../src/evolve/battery-case.js';
import type { BatteryCase, Machine, Trace } from '../src/evolve/battery-judge.js';
import { BATTERY_CALL_KIND, isReadOnlyCall, judge } from '../src/evolve/battery-judge.js';
import { MemoryStore } from '../src/memory.js';
import { createMemoryTool } from '../src/tools/memory.js';
import { createReminderTool } from '../src/tools/reminder.js';

// Las acciones que de verdad tienen las herramientas de la batería, leídas de su esquema.
const dir = mkdtempSync(join(tmpdir(), 'pa-ro-'));
const store = new Store(join(dir, 'pa.db'));
afterAll(() => {
  store.close?.();
  rmSync(dir, { recursive: true, force: true });
});
type Schema = { properties?: { action?: { anyOf?: { const?: string }[] } } };
const actions = (tool: { name: string; parameters: unknown }): string[] =>
  ((tool.parameters as Schema).properties?.action?.anyOf ?? []).map(
    (x) => `${tool.name}.${x.const}`,
  );
const batteryCalls = [
  ...actions(createMemoryTool(new MemoryStore(join(dir, 'memory')), () => 's') as never),
  ...actions(createReminderTool({ store, scopeOf: () => 's', sync: () => {} }) as never),
  ...WORKSPACE_TOOLS,
];

const t = (o: Partial<Trace>): Trace => ({ reply: 'ok', toolCalls: [], approvalsAsked: 0, ...o });
const c = (machine: Machine): BatteryCase => ({ id: 'x', prompt: 'p', machine });

describe('clasificación lee/actúa de las llamadas de la batería', () => {
  it('toda acción de una herramienta de la batería está clasificada', () => {
    expect(batteryCalls.length).toBeGreaterThan(10);
    const sinClasificar = batteryCalls.filter((n) => !Object.hasOwn(BATTERY_CALL_KIND, n));
    expect(sinClasificar).toEqual([]);
  });

  it('las de solo lectura que el nombre no delataba cuentan como lectura', () => {
    for (const n of ['memory.profile', 'memory.timeline', 'memory.history', 'memory.suggest_nudge'])
      expect(isReadOnlyCall(n), n).toBe(true);
    for (const n of ['memory.remember', 'memory.save_profile', 'reminder.create', 'write'])
      expect(isReadOnlyCall(n), n).toBe(false);
  });

  it('fuera de la tabla sigue mandando el nombre', () => {
    expect(isReadOnlyCall('browser.snapshot')).toBe(true);
    expect(isReadOnlyCall('browser.click')).toBe(false);
    for (const n of INERT_TOOLS) expect(typeof isReadOnlyCall(n)).toBe('boolean');
  });

  it('leer el perfil no respalda «guardado»', () => {
    const j = judge(
      c({ noFalseClaim: true }),
      t({ reply: 'Guardado en tu perfil.', toolCalls: [{ name: 'memory.profile', ok: true }] }),
    );
    expect(j.verdict).toBe('fail');
    const ok = judge(
      c({ noFalseClaim: true }),
      t({
        reply: 'Guardado en tu perfil.',
        toolCalls: [{ name: 'memory.save_profile', ok: true }],
      }),
    );
    expect(ok.verdict).toBe('pass');
  });
});
