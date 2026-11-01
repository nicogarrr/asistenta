/**
 * F11 paso 3: `/learn web <url>` conecta la demostración al navegador real.
 *
 * `/learn web <url>` abre la página en la ventana visible del navegador de la
 * conversación e instala un listener (clic, cambio de campo, envío y
 * navegación). La persona hace la tarea una vez; `/learn end` lee los eventos,
 * los pasa por `recordDemo` → `demoToPlaybook` y guarda el playbook del dominio
 * en el almacén del gestor, con la misma guarda de valores del vault que
 * `playbook_guardar`. Apagado por defecto: solo con PA_TEACH_DEMO=1; apagado,
 * `/learn` se comporta exactamente como antes.
 *
 * Seguridad (solo más estricto):
 * - el listener no envía nunca el valor de un campo de contraseña;
 * - los eventos vienen de la página, así que se validan forma y tamaño aquí y
 *   se descartan los que no encajan;
 * - el playbook solo guarda selectores y nombres de clave (ver demoToPlaybook)
 *   y no se escribe si su contenido coincide con un valor actual del vault.
 */
import {
  canonicalPlaybookDomain,
  containsVaultValue,
  type Playbook,
  renderPlaybook,
} from './gestor/playbooks.js';
import {
  type DemoEvent,
  type DemoTarget,
  demoToPlaybook,
  isSensitiveField,
  MAX_DEMO_EVENTS,
  recordDemo,
  teachDemoEnabled,
} from './teach-demo.js';

/** Lo que usa del navegador (BrowserService lo cumple; los tests usan uno falso). */
export interface DemoBrowser {
  open(scope: string, url: string, opts?: { visible?: boolean }): Promise<unknown>;
  execJs(
    scope: string,
    code: string,
    opts?: { visible?: boolean },
  ): Promise<{ text: string; timedOut: boolean }>;
}

/** Lo que usa del almacén de playbooks (PlaybookStore lo cumple). */
export interface DemoPlaybookStore {
  read(domain: string): Playbook | null;
  save(pb: Playbook): void;
}

const MAX_FIELD = 120;
const MAX_VALUE = 200;
const CHUNK = 5;

/** Listener que se inyecta en cada página (idempotente). */
export const DEMO_LISTENER_JS = `(() => {
  if (window.__paDemoOn) return;
  window.__paDemoOn = true;
  const cut = (v) => (typeof v === 'string' && v ? v.slice(0, ${MAX_FIELD}) : undefined);
  const tgt = (el) => {
    const pick = el && el.closest ? el.closest('button,a,input,select,textarea,[role],[data-testid]') || el : el;
    if (!pick || !pick.getAttribute) return {};
    return {
      testId: cut(pick.getAttribute('data-testid')),
      id: cut(pick.id),
      name: cut(pick.getAttribute('name')),
      ariaLabel: cut(pick.getAttribute('aria-label')),
      role: cut(pick.getAttribute('role')),
      text: cut((pick.innerText || '').trim()),
      tag: cut((pick.tagName || '').toLowerCase()),
      inputType: cut(pick.getAttribute('type')),
      autocomplete: cut(pick.getAttribute('autocomplete')),
    };
  };
  const send = (e) => { try { window.__paDemoPush(e); } catch {} };
  document.addEventListener('click', (ev) => send({ type: 'click', target: tgt(ev.target) }), true);
  document.addEventListener('change', (ev) => {
    const el = ev.target;
    if (!el || typeof el.value !== 'string') return;
    const pw = String(el.type || '').toLowerCase() === 'password';
    send({ type: 'input', target: tgt(el), value: pw ? '' : el.value.slice(0, ${MAX_VALUE}) });
  }, true);
  document.addEventListener('submit', (ev) => send({ type: 'submit', target: tgt(ev.target) }), true);
})()`;

const START_JS = `
if (!state.paDemoReady) {
  state.paDemoReady = true;
  state.paDemo = [];
  await page.exposeFunction('__paDemoPush', (e) => {
    if (state.paDemoOn && state.paDemo.length <= ${MAX_DEMO_EVENTS}) state.paDemo.push(e);
  });
  page.on('framenavigated', (f) => {
    if (state.paDemoOn && f === page.mainFrame() && state.paDemo.length <= ${MAX_DEMO_EVENTS})
      state.paDemo.push({ type: 'navigate', url: f.url() });
  });
  await page.addInitScript(${JSON.stringify(DEMO_LISTENER_JS)});
}
state.paDemo = [{ type: 'navigate', url: page.url() }];
state.paDemoOn = true;
await page.evaluate(${JSON.stringify(DEMO_LISTENER_JS)});
return 'paDemo:ok';
`;

const STOP_JS = `state.paDemoOn = false; return 'paDemo:' + (state.paDemo || []).length;`;
const chunkJs = (i: number) =>
  `return JSON.stringify((state.paDemo || []).slice(${i}, ${i + CHUNK}));`;

const TARGET_KEYS = [
  'testId',
  'id',
  'name',
  'ariaLabel',
  'role',
  'text',
  'tag',
  'inputType',
  'autocomplete',
] as const;

function cleanTarget(raw: unknown): DemoTarget | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: DemoTarget = {};
  for (const k of TARGET_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' || v.length > MAX_FIELD) return null;
    if (v) out[k] = v;
  }
  return out;
}

/**
 * Eventos tal y como llegan de la página → DemoEvent validados. Un evento con
 * forma o tamaño inesperados se descarta; el valor de un campo sensible se
 * vacía aquí también (nunca sale de este proceso, pero tampoco hace falta).
 */
export function parseDemoEvents(raw: readonly unknown[]): DemoEvent[] {
  const out: DemoEvent[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    if (r.type === 'navigate') {
      if (typeof r.url === 'string' && r.url.length <= 2000)
        out.push({ type: 'navigate', url: r.url });
      continue;
    }
    if (r.type !== 'click' && r.type !== 'submit' && r.type !== 'input') continue;
    const target = cleanTarget(r.target);
    if (!target) continue;
    if (r.type !== 'input') {
      out.push({ type: r.type, target });
      continue;
    }
    if (typeof r.value !== 'string' || r.value.length > MAX_VALUE) continue;
    out.push({ type: 'input', target, value: isSensitiveField(target) ? '' : r.value });
  }
  return out;
}

const failed = (text: string) => text.startsWith('error:');

/** Grabaciones web en curso, una por conversación. */
/** Tiempo máximo de una grabación web antes de caducar. */
export const DEMO_TTL_MS = 30 * 60_000;

export class WebDemoRecorder {
  readonly #active = new Map<string, { host: string; startedMs: number }>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  /** Una grabación olvidada caduca (30 min por defecto): no se queda abierta para siempre. */
  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.#ttlMs = opts.ttlMs ?? DEMO_TTL_MS;
    this.#now = opts.now ?? Date.now;
  }

  #expired(entry: { startedMs: number }): boolean {
    return this.#now() - entry.startedMs > this.#ttlMs;
  }

  isRecording(key: string): boolean {
    const entry = this.#active.get(key);
    return entry !== undefined && !this.#expired(entry);
  }

  /**
   * `/learn web <url>`. Devuelve el mensaje para la persona. Con PA_TEACH_DEMO
   * apagado devuelve null: quien llama sigue con el `/learn` de siempre.
   */
  async start(
    key: string,
    rawUrl: string,
    deps: { browser: DemoBrowser; env?: NodeJS.ProcessEnv },
  ): Promise<string | null> {
    if (!teachDemoEnabled(deps.env)) return null;
    let url: URL;
    try {
      url = new URL(rawUrl.trim());
    } catch {
      return '¿En qué web te miro? Pásame el enlace.';
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return '¿En qué web te miro? Pásame el enlace.';
    }
    url.username = '';
    url.password = '';
    try {
      await deps.browser.open(key, url.href, { visible: true });
      const r = await deps.browser.execJs(key, START_JS, { visible: true });
      if (r.timedOut || failed(r.text) || r.text !== 'paDemo:ok') {
        return 'No pude empezar a grabar en el navegador. Prueba otra vez con /learn web.';
      }
    } catch {
      return 'No pude abrir el navegador para grabar. Prueba otra vez con /learn web.';
    }
    this.#active.set(key, { host: url.hostname, startedMs: this.#now() });
    return `Grabando la demostración en ${url.hostname}. Hazla en la ventana del navegador; cuando acabes, dime «ya está». Las contraseñas no se graban.`;
  }

  /**
   * `/learn end` con una grabación web en curso: lee, convierte y guarda.
   * Devuelve null si esta conversación no estaba grabando en la web.
   */
  async finish(
    key: string,
    deps: {
      browser: DemoBrowser;
      store: DemoPlaybookStore;
      vaultValues: () => Promise<string[]>;
      env?: NodeJS.ProcessEnv;
      deniedHosts?: readonly string[];
      now?: Date;
    },
  ): Promise<string | null> {
    const entry = this.#active.get(key);
    if (!entry) return null;
    this.#active.delete(key);
    if (!teachDemoEnabled(deps.env)) return null;
    if (this.#expired(entry)) {
      // Se apaga la escucha de la página y se descarta lo grabado: no se guarda nada.
      try {
        await deps.browser.execJs(key, STOP_JS);
      } catch {
        // El navegador puede estar cerrado ya: no hay nada más que apagar.
      }
      const min = Math.round(this.#ttlMs / 60_000);
      return `La grabación en ${entry.host} caducó (más de ${min} min) y no se ha guardado nada. Empieza otra con /learn web.`;
    }
    const raw: unknown[] = [];
    try {
      const stop = await deps.browser.execJs(key, STOP_JS);
      const n = Number(/^paDemo:(\d+)$/.exec(stop.text)?.[1] ?? Number.NaN);
      if (!Number.isInteger(n)) return 'No pude leer la demostración del navegador.';
      if (n > MAX_DEMO_EVENTS) {
        return `La demostración tiene demasiados pasos (máximo ${MAX_DEMO_EVENTS}): enséñala en partes más cortas.`;
      }
      for (let i = 0; i < n; i += CHUNK) {
        const r = await deps.browser.execJs(key, chunkJs(i));
        const part: unknown = JSON.parse(r.text);
        if (!Array.isArray(part)) return 'No pude leer la demostración del navegador.';
        raw.push(...part);
      }
    } catch {
      return 'No pude leer la demostración del navegador.';
    }
    const demo = recordDemo(parseDemoEvents(raw), { deniedHosts: deps.deniedHosts, env: deps.env });
    if (!demo.ok) return demo.reason;
    const first = demoToPlaybook(demo, { env: deps.env, now: deps.now });
    if (!first.ok) return first.reason;
    const domain = canonicalPlaybookDomain(first.playbook.domain) ?? first.playbook.domain;
    const res = demoToPlaybook(demo, {
      env: deps.env,
      now: deps.now,
      existing: deps.store.read(domain),
    });
    if (!res.ok) return res.reason;
    const pb = res.playbook;
    if (containsVaultValue(renderPlaybook(pb), await deps.vaultValues())) {
      return 'El playbook no se guarda: su contenido coincide con un valor del vault.';
    }
    deps.store.save(pb);
    return `Playbook de ${pb.domain} guardado: ${pb.selectores.length} selectores y ${pb.login.length} campos secretos (solo el nombre de la clave). Los valores que escribiste no se guardan.`;
  }
}
