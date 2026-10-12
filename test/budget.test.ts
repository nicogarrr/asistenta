import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import type { PersonalAgent } from '../src/core/agent.js';
import { IterationBudget } from '../src/core/budget.js';
import { Gate } from '../src/permissions.js';

/**
 * The iteration budget is a per-request safety ceiling, not a daily quota.
 *
 * The bug this file exists for: `PersonalAgent` lives for weeks (one per
 * conversation) and the budget used to be a single counter for its whole life. A
 * user chatting through the morning therefore started every afternoon request
 * almost out of iterations, and the model was told "quedan 2 pasos" for work that
 * had not begun. Nothing errored, nothing logged, the agent just quietly became
 * useless — the worst kind of failure, because no test could see it.
 *
 * Environment is prepared before importing the agent because `paths.ts` snapshots
 * `PA_STATE_DIR` at import time, and the portable vault backend is what lets
 * `create()` resolve a key without a real DPAPI vault or a network call. The key is
 * never used: nothing in this file sends a request.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-budget-'));
process.env.PA_STATE_DIR = stateDir;
process.env.PA_VAULT_BACKEND = 'portable';
process.env.PA_SECRET_PROVIDER_APIKEY = 'test-key-never-used';
// La config de este test apunta a un endpoint propio (127.0.0.1:1), y para un
// endpoint que no es de OpenCode la clave tiene que venir de PA_API_KEY con ese
// nombre exacto: la clave del vault no se reutiliza ahi para no mandar el
// secreto de OpenCode a un tercero por accidente.
process.env.PA_API_KEY = 'test-key-never-used';

const { PersonalAgent: AgentClass, resolveIterationBudget } = await import('../src/core/agent.js');

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

const CONFIG: Config = {
  provider: 'test-provider',
  model: 'test-model',
  baseUrl: 'http://127.0.0.1:1/v1',
  toolTimeoutMs: 1_000,
  runTimeoutMs: 1_000,
  idleTimeoutMs: 1_000,
  screenshotMaxEdge: 800,
  screenshotQuality: 75,
  verifyActions: false,
  verifySettleMs: 100,
  cron: [],
  retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
  maxToolCalls: 20,
  // Fields the config gained on main (browser channel, download cookies, curl
  // impersonate). Defaults, so a test that does not care about them says so instead of
  // silently omitting a required field.
  browserChannel: 'chromium',
  downloadCookiesBrowser: '',
  curlImpersonatePath: '',
};

async function makeAgent(iterationBudget?: {
  max: number;
  shared?: boolean;
}): Promise<PersonalAgent> {
  return AgentClass.create(
    CONFIG,
    [],
    new Gate({
      dbPath: join(stateDir, `gate-${Math.random().toString(36).slice(2)}.db`),
      grantWindowMs: 0,
      approver: () => true,
    }),
    'local',
    iterationBudget ? { iterationBudget } : {},
  );
}

describe('IterationBudget', () => {
  it('refills an exhausted budget', () => {
    const budget = new IterationBudget(5);
    budget.consume(9);
    expect(budget.remaining()).toBe(0);
    expect(budget.isExhausted()).toBe(true);
    // The refill is what a new request starts from; without it the agent would
    // carry yesterday's leftovers into today's task.
    budget.reset();
    expect(budget.remaining()).toBe(5);
    expect(budget.isExhausted()).toBe(false);
  });

  it('shares the counter with a child, so delegation buys no extra allowance', () => {
    const parent = new IterationBudget(4);
    const child = parent.child();

    child.consume(3);
    expect(parent.remaining()).toBe(1);

    // ...and the refill reaches the child too: the child is still on the same task.
    parent.reset();
    expect(child.remaining()).toBe(4);

    parent.consume(4);
    expect(child.remaining()).toBe(0);
    expect(child.isExhausted()).toBe(true);
  });

  it('reports the three pressure tramos, worded as this task and not the day', () => {
    const budget = new IterationBudget(20);

    budget.consume(6); // 70% left: plenty, no distraction
    expect(budget.pressure()).toBeNull();

    budget.consume(8); // 30% left: start closing
    const aviso = budget.pressure();
    expect(aviso).toBe('De esta tarea quedan 6 pasos de 20. Cierra con lo que tengas.');

    budget.consume(4); // 10% left: still the plain aviso
    expect(budget.pressure()).toBe('De esta tarea quedan 2 pasos de 20. Cierra con lo que tengas.');

    budget.consume(1); // 5% left: urgent
    const urgente = budget.pressure();
    expect(urgente).toBe(
      '¡Atención! De esta tarea queda solo 1 paso de 20. Cierra ya con lo que tengas.',
    );

    budget.consume(1); // nothing left
    expect(budget.pressure()).toBe(
      'Se ha agotado el presupuesto de esta tarea: 20 pasos. Cierra con lo que tengas.',
    );

    // Plural urgent, and the singular plain branch (only reachable on a small
    // budget, where one step of five is still 20% and not yet an emergency).
    const wide = new IterationBudget(40);
    wide.consume(38);
    expect(wide.pressure()).toBe(
      '¡Atención! De esta tarea quedan solo 2 pasos de 40. Cierra ya con lo que tengas.',
    );
    const small = new IterationBudget(5);
    small.consume(4);
    expect(small.pressure()).toBe('De esta tarea queda 1 paso de 5. Cierra con lo que tengas.');

    // The wording is the fix, not decoration: a model that reads this as a daily
    // allowance abandons a two-step request it could finish easily.
    for (const text of [aviso, urgente, budget.pressure()]) {
      expect(text?.toLowerCase()).toContain('de esta tarea');
    }
  });

  it('defaults the budget to per-request, not per-agent-life', () => {
    // Pure policy check: fails immediately if someone flips `shared` back to true.
    expect(resolveIterationBudget(undefined, 20).sharedBudget).toBe(false);
    expect(resolveIterationBudget({ max: 8 }, 20).sharedBudget).toBe(false);
    expect(resolveIterationBudget({ max: 8, shared: false }, 20).sharedBudget).toBe(false);
    expect(resolveIterationBudget({ max: 8, shared: true }, 20).sharedBudget).toBe(true);
    expect(resolveIterationBudget(undefined, 20).budget.remaining()).toBe(20);
  });
});

describe('PersonalAgent budget scope', () => {
  it('gives a second run a full budget when shared is false (the default)', async () => {
    const agent = await makeAgent();
    agent.beginRun();
    expect(agent.budgetRemaining()).toBe(20);

    // First task spends almost everything.
    agent.budget.consume(18);
    expect(agent.budgetRemaining()).toBe(2);

    // Second task the same afternoon: the model must not be told "quedan 2 pasos"
    // before doing anything.
    agent.beginRun();
    expect(agent.budgetRemaining()).toBe(20);
    expect(agent.budget.pressure()).toBeNull();

    // ...and with an explicit `shared: false` too, for callers that spell it out.
    const explicit = await makeAgent({ max: 20, shared: false });
    explicit.beginRun();
    explicit.budget.consume(20);
    explicit.beginRun();
    expect(explicit.budgetRemaining()).toBe(20);
  });

  it('keeps a shared budget spent when the caller explicitly asks for a session ceiling', async () => {
    const agent = await makeAgent({ max: 20, shared: true });
    agent.beginRun();
    agent.budget.consume(18);

    // This is the old default, and the reason afternoon tasks started crippled:
    // nothing failed, the model just gave up early from then on.
    agent.beginRun();
    expect(agent.budgetRemaining()).toBe(2);
  });

  it('does not refill mid-task, where a refill would feed the loop it is squeezing', async () => {
    const agent = await makeAgent();
    agent.beginRun();
    agent.budget.consume(20);
    // Only `beginRun()` refills. A tool call at the ceiling stays at zero.
    expect(agent.budgetRemaining()).toBe(0);
    expect(agent.budget.pressure()).toContain('Se ha agotado');
  });
});
