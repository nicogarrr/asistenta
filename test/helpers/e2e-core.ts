import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type {
  AssistantMessage,
  FauxResponseFactory,
  TranscriptContext,
} from '@earendil-works/pi-ai';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import type { ActionRecord } from '../../src/audit/log.js';
import type { ApprovalChoice } from '../../src/channels/telegram.js';
import { buildContextNote, createDaemonGate } from '../../src/cli.js';
import type { Config } from '../../src/config.js';
import { PersonalAgent } from '../../src/core/agent.js';
import { createGoalTickExecute, type ThreadTickDeps } from '../../src/daemon/goal-tick.js';
import { createRoutineFire, deliverMissedThenStart } from '../../src/daemon/routine-fire.js';
import { createRoutineTask } from '../../src/daemon/routine-task.js';
import { Store } from '../../src/db.js';
import { GoalNotifier } from '../../src/goals/notify.js';
import { GoalRunner } from '../../src/goals/runner.js';
import { GoalStore, splitGoalScope } from '../../src/goals/store.js';
import { SessionStore } from '../../src/memory/sessions.js';
import { WorkstreamStore } from '../../src/memory/workstreams.js';
import { MemoryStore } from '../../src/memory.js';
import { RoutineDeliveryStore } from '../../src/routine-delivery.js';
import { RoutineRunner } from '../../src/routines.js';
import { createGoalTool } from '../../src/tools/goal.js';
import { createMemoryTool } from '../../src/tools/memory.js';
import { createReminderTool } from '../../src/tools/reminder.js';
import { createTvTool, type TvMemoryState } from '../../src/tools/tv.js';

/**
 * Arnés de punta a punta sin cuentas reales: el núcleo del daemon (agente, Gate
 * real con su política de aprobaciones, SQLite temporal, memoria, objetivos y
 * planificador) con un modelo guionizado, un Telegram falso que apunta lo que
 * se envía y contesta a los botones de aprobación, y una tele falsa.
 *
 * El proveedor se sustituye en el test con vi.mock('../src/core/provider.js')
 * apuntando a `providerState`; todo lo demás es el código de producción.
 */

/** El mock de src/core/provider.js del test devuelve este handle. */
const g = globalThis as unknown as { __e2eProvider?: { handle: unknown } };
if (!g.__e2eProvider) g.__e2eProvider = { handle: null };
export const providerState: { handle: unknown } = g.__e2eProvider;

export const E2E_CONFIG: Config = {
  webMaxCostEur: 0,
  voiceWake: { engine: 'whisper', owwModel: '', owwThreshold: 0.5 },
  provider: 'test-provider',
  model: 'test-model',
  baseUrl: 'http://127.0.0.1:1/v1',
  contextWindowTokens: 1_048_576,
  maxOutputTokens: 32_000,
  dailyBudgetEur: 0,
  toolTimeoutMs: 2_000,
  runTimeoutMs: 10_000,
  idleTimeoutMs: 5_000,
  screenshotMaxEdge: 800,
  screenshotQuality: 75,
  verifyActions: false,
  verifySettleMs: 100,
  cron: [],
  retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
  maxToolCalls: 20,
  browserChannel: 'chromium',
  downloadCookiesBrowser: '',
  curlImpersonatePath: '',
};

/** Modelo guionizado: cada respuesta es una función que ve el contexto recibido. */
export class ScriptedModel {
  readonly contexts: TranscriptContext[] = [];
  readonly #faux = createFauxCore({
    provider: 'test-provider',
    models: [{ id: 'test-model' }],
    tokenSize: { min: 10_000, max: 10_000 },
  });

  constructor() {
    const model = this.#faux.getModel();
    providerState.handle = {
      model,
      streamFn: this.#faux.streamSimple,
      modelFor: () => model,
      models: { completeSimple: async () => fauxAssistantMessage('') },
      fallbackFor: undefined,
    };
  }

  script(...steps: Array<AssistantMessage | (() => AssistantMessage)>): void {
    const factories: FauxResponseFactory[] = steps.map((step) => (context) => {
      this.contexts.push(context);
      return typeof step === 'function' ? step() : step;
    });
    this.#faux.setResponses(factories);
  }

  /** Texto de todo lo que el modelo recibió en la última petición. */
  lastRequest(): string {
    return JSON.stringify(this.contexts.at(-1) ?? {});
  }
}

let callSeq = 0;
export function call(tool: string, args: Parameters<typeof fauxToolCall>[1]): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall(tool, args, { id: `c${++callSeq}` })], {
    stopReason: 'toolUse',
  });
}
export const say = (text: string): AssistantMessage => fauxAssistantMessage(text);

export interface Sent {
  chatId: string;
  text: string;
}

/** Telegram falso: apunta mensajes y preguntas; las respuestas a botones se encolan. */
export class FakeTelegram {
  readonly account = 'fake';
  readonly sent: Sent[] = [];
  readonly approvals: Array<{ chatId: string; question: string; approved: boolean }> = [];
  /** Respuestas que dará Nico a los próximos botones (por defecto, «no»). */
  readonly answers: Array<boolean | ApprovalChoice> = [];
  failSends = 0;

  async send(o: { chatId: string; text: string }): Promise<string | null> {
    if (this.failSends > 0) {
      this.failSends--;
      throw new Error('telegram caído');
    }
    this.sent.push({ chatId: String(o.chatId), text: o.text });
    return String(1000 + this.sent.length);
  }

  async offerApproval(chatId: string, question: string): Promise<ApprovalChoice> {
    const next = this.answers.shift() ?? false;
    const choice: ApprovalChoice =
      typeof next === 'boolean' ? { approved: next, scope: 'once' } : next;
    this.approvals.push({ chatId, question, approved: choice.approved });
    return choice;
  }
}

/** Tele falsa: registra cada orden; nunca toca una tele real. */
export class FakeTv {
  readonly calls: string[] = [];
  powered = true;
  state: TvMemoryState | null = null;
  deps() {
    return {
      shot: async () => ({ image: Buffer.from([0xff, 0xd8, 0xff]), mimeType: 'image/jpeg' }),
      foreground: async () => ({ appId: 'netflix', category: ['video'] }),
      apps: async () => [{ id: 'netflix', title: 'Netflix' }],
      launch: async (id: string) => {
        this.calls.push(`launch:${id}`);
      },
      key: async (name: string) => {
        this.calls.push(`key:${name}`);
      },
      toast: async (m: string) => {
        this.calls.push(`toast:${m}`);
      },
      power: async (on: boolean) => {
        this.calls.push(`power:${on}`);
        this.powered = on;
      },
      saveFrame: () => '/dev/null',
      getState: () => this.state,
      setState: (s: TvMemoryState) => {
        this.state = s;
      },
    };
  }
}

export const CHAT_ID = '424242';
export const chatKey = (chatId = CHAT_ID): string => `telegram:dm:${chatId}`;
export const threadKey = (chatId = CHAT_ID, thread = 'main'): string =>
  `${chatKey(chatId)}#${thread}`;

export interface Thread {
  key: string;
  name: string;
  agent: Awaited<ReturnType<typeof PersonalAgent.create>>;
  gate: ReturnType<typeof createDaemonGate>;
  /** Un mensaje de Nico: sesión, nota de contexto y turno del agente, como el daemon. */
  user: (text: string) => Promise<Awaited<ReturnType<PersonalAgent['run']>>>;
  tail: Promise<unknown>;
  generation: number;
  active: boolean;
}

/**
 * Un «arranque» del núcleo sobre un directorio de estado. Cerrar y volver a
 * llamar con el mismo directorio es un reinicio del daemon.
 */
export class Core {
  readonly telegram: FakeTelegram;
  readonly tv: FakeTv;
  readonly store: Store;
  readonly goalsDb: DatabaseSync;
  readonly memoryDb: DatabaseSync;
  readonly goals: GoalStore;
  readonly workstreams: WorkstreamStore;
  readonly sessions: SessionStore;
  readonly memory: MemoryStore;
  readonly notifier: GoalNotifier;
  readonly routines: RoutineRunner;
  readonly goalRunner: GoalRunner;
  readonly threads = new Map<string, Thread>();
  readonly #stateDir: string;

  constructor(stateDir: string, opts: { telegram?: FakeTelegram; tv?: FakeTv } = {}) {
    this.#stateDir = stateDir;
    mkdirSync(stateDir, { recursive: true });
    this.telegram = opts.telegram ?? new FakeTelegram();
    this.tv = opts.tv ?? new FakeTv();
    this.store = new Store(join(stateDir, 'pa.db'));
    this.goalsDb = new DatabaseSync(join(stateDir, 'goals.db'));
    this.memoryDb = new DatabaseSync(join(stateDir, 'memory.db'));
    this.goals = new GoalStore({ db: this.goalsDb });
    this.workstreams = new WorkstreamStore({ db: this.memoryDb });
    this.sessions = new SessionStore({ db: this.memoryDb });
    this.memory = new MemoryStore(join(stateDir, 'memory'));
    this.notifier = new GoalNotifier({
      db: this.goalsDb,
      resolveGoal: (id) => this.goals.read(id),
      send: async (goal, text) => {
        const chatId = splitGoalScope(goal.scope).chatKey.split(':')[2] ?? '';
        try {
          return await this.telegram.send({ chatId, text });
        } catch {
          return null;
        }
      },
    });
    this.routines = new RoutineRunner({
      store: this.store,
      run: (prompt, ctx) => this.#fire(prompt, ctx),
      timeoutMs: 10_000,
    });
    this.goalRunner = new GoalRunner({
      goals: this.goals,
      workstreams: this.workstreams,
      notifier: this.notifier,
      store: this.store,
      sync: () => this.routines.sync(),
      // El MISMO execute que el daemon (src/daemon/goal-tick.ts).
      execute: createGoalTickExecute({ ...this.#tickDeps(), actions: this.actions }),
    });
    this.#fire = this.#createFire();
  }

  /**
   * El MISMO disparo de rutinas que usa el daemon (src/daemon/routine-fire.ts):
   * tick de objetivo, recordatorio o rutina que trabaja en el hilo de su scope.
   */
  readonly #fire: ReturnType<typeof createRoutineFire>;

  /** Registro de acciones (en memoria) que alimenta el tick de objetivo. */
  readonly actions = {
    records: [] as ActionRecord[],
    record(entry: ActionRecord): void {
      this.records.push(entry);
    },
  };

  /** Dependencias de tick (objetivo/rutina) como las construye el daemon. */
  #tickDeps(): ThreadTickDeps<Thread> {
    return {
      threadFor: (chatKey, name) => this.thread(chatKey.split(':')[2] ?? '', name),
      sessions: this.sessions,
      contextNoteFor: (t) =>
        buildContextNote(
          { key: t.key, name: t.name },
          this.store,
          this.memory,
          undefined,
          this.workstreams,
          undefined,
          this.sessions,
        ),
      safeRemember: (fn) => fn(),
    };
  }

  #createFire(): ReturnType<typeof createRoutineFire> {
    return createRoutineFire({
      store: this.store,
      tickGoal: (name) => this.goalRunner.tickByRoutineName(name),
      runTask: createRoutineTask(this.#tickDeps()),
      send: (chatId, text) => this.telegram.send({ chatId, text }),
      delivery: new RoutineDeliveryStore(join(this.#stateDir, 'routine-delivery.json')),
      outputDir: join(this.#stateDir, 'salidas'),
      sync: () => this.routines.sync(),
      droppedRemindersPath: join(this.#stateDir, 'dropped-reminders.jsonl'),
    });
  }

  start(): this {
    this.routines.start();
    return this;
  }

  /**
   * Arranque como el del daemon (deliverMissedThenStart): primero los
   * recordatorios puntuales vencidos (con el daemon apagado a su hora),
   * después el planificador.
   */
  async startLikeDaemon(): Promise<this> {
    await deliverMissedThenStart({
      store: this.store,
      send: (chatId, text) => this.telegram.send({ chatId, text }),
      start: () => this.start(),
    });
    return this;
  }

  async thread(chatId = CHAT_ID, name = 'main'): Promise<Thread> {
    const key = threadKey(chatId, name);
    const existing = this.threads.get(key);
    if (existing) return existing;
    const scope = (): string => key;
    const gate = createDaemonGate({
      threadKey: key,
      dbPath: join(this.#stateDir, 'approvals.db'),
      ask: (_t, _tool, _reason, question) =>
        this.telegram.offerApproval(chatId, question ?? `¿Permito ${_tool}?`),
    });
    const tools: AgentTool[] = [
      createMemoryTool(this.memory, scope, undefined, undefined, this.sessions),
      createReminderTool({ store: this.store, scopeOf: scope, sync: () => this.routines.sync() }),
      createGoalTool({
        goals: this.goals,
        scopeOf: scope,
        store: this.store,
        sync: () => this.routines.sync(),
        workstreams: this.workstreams,
        humanRepliedAfter: (k, since) => this.sessions.hasHumanTurnSince(k, Date.parse(since)),
      }),
      createTvTool(this.tv.deps()) as unknown as AgentTool,
      ...this.extraTools,
    ];
    const agent = await PersonalAgent.create(E2E_CONFIG, tools, gate, 'e2e', {
      sessionId: `e2e-${key}`,
      desktop: false,
    });
    const t: Thread = {
      key,
      name,
      agent,
      gate,
      tail: Promise.resolve(),
      generation: 0,
      active: false,
      user: async (text: string) => {
        const sid = this.sessions.begin(key, text.slice(0, 80));
        this.sessions.addTurn(sid, 'user', text);
        agent.attachContext(
          buildContextNote(
            { key, name },
            this.store,
            this.memory,
            undefined,
            this.workstreams,
            undefined,
            this.sessions,
          ),
        );
        const r = await agent.run(text);
        gate.clearSession(key);
        this.sessions.addTurn(sid, 'assistant', (r.text ?? '').slice(0, 500));
        this.sessions.end(sid, (r.text ?? '').slice(0, 200));
        return r;
      },
    };
    this.threads.set(key, t);
    return t;
  }

  extraTools: AgentTool[] = [];

  /** Parada del daemon: temporizadores fuera y bases cerradas. */
  stop(): void {
    this.routines.stop();
    this.goalsDb.close();
    this.memoryDb.close();
    this.store.close?.();
  }
}
