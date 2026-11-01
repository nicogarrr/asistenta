/**
 * Broker de aprobaciones compartido por todos los canales.
 *
 * Cada canal (Telegram, panel web) puede listar y resolver la misma aprobación
 * pendiente: este registro es la única fuente de verdad. No aplica la decisión
 * (`once`, `session`, `always` o `deny`); solo la transporta hasta quien la
 * pidió y hasta los canales que estén esperando.
 */
import { randomUUID } from 'node:crypto';
import { log } from '../log.js';

export type ApprovalDecision = 'once' | 'session' | 'always' | 'deny';

export interface PendingApproval {
  id: string;
  tool: string;
  reason: string;
  question: string;
  createdAt: number;
  expiresAt: number;
  chatId?: string;
  threadId?: string;
  /**
   * Solo admite «una vez» o «denegar» (lo pide un especialista: nunca deja permisos
   * para más tarde). «Por ahora» y «Siempre» se rechazan y la pregunta sigue pendiente.
   */
  onceOnly?: boolean;
}

/** TTL por defecto: cinco minutos, igual que la caducidad del canal de Telegram. */
const DEFAULT_TTL_MS = 300_000;

/**
 * Decisiones ya tomadas que se conservan para que un `wait` que llega tarde no
 * se quede colgado. El límite evita que el mapa crezca sin fin en un daemon que
 * vive durante días.
 */
const RESOLVED_LIMIT = 256;

interface Entry {
  approval: PendingApproval;
  resolve: (decision: ApprovalDecision) => void;
  waiters: Set<(decision: ApprovalDecision) => void>;
}

/** El registro nunca debe romper la resolución por un fallo al escribir el log. */
function warn(msg: string, fields: Record<string, unknown>): void {
  try {
    log.warn(msg, fields);
  } catch {
    // Silencio deliberado: la decisión ya está tomada y no puede depender del log.
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ApprovalBroker {
  readonly #pending = new Map<string, Entry>();
  readonly #resolved = new Map<string, ApprovalDecision>();

  /**
   * Registra una aprobación pendiente y devuelve su vista pública. `resolve` es
   * el callback de quien la pidió (normalmente el `Gate`); se llama una sola vez,
   * con la decisión que gane la carrera entre canales, caducidad o timeout.
   */
  register(
    input: Omit<PendingApproval, 'id' | 'createdAt' | 'expiresAt'> & {
      ttlMs?: number;
      resolve: (decision: ApprovalDecision) => void;
    },
  ): PendingApproval {
    const { ttlMs, resolve, ...rest } = input;
    const createdAt = Date.now();
    const ttl =
      typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : DEFAULT_TTL_MS;
    const approval: PendingApproval = {
      ...rest,
      id: randomUUID(),
      createdAt,
      expiresAt: createdAt + ttl,
    };
    this.#pending.set(approval.id, { approval, resolve, waiters: new Set() });
    return approval;
  }

  /** Aprobaciones todavía sin resolver; `chatId` filtra las de un solo chat. */
  list(opts: { chatId?: string } = {}): PendingApproval[] {
    const all = [...this.#pending.values()].map((entry) => entry.approval);
    if (opts.chatId === undefined) return all;
    return all.filter((approval) => approval.chatId === opts.chatId);
  }

  get(id: string): PendingApproval | undefined {
    return this.#pending.get(id)?.approval;
  }

  /**
   * Resuelve una aprobación una única vez. La entrada se borra antes de avisar
   * a nadie, de modo que un doble clic o un callback reentrante recibe `false`
   * y no vuelve a disparar el callback.
   */
  resolve(id: string, decision: ApprovalDecision): boolean {
    const entry = this.#pending.get(id);
    if (!entry) return false;
    if (entry.approval.onceOnly && decision !== 'once' && decision !== 'deny') return false;

    // Una aprobación caducada que aún no barrió `expire()` NO puede concederse:
    // se cierra como `deny` y quien intentó aprobar recibe `false`.
    const lapsed = entry.approval.expiresAt <= Date.now();
    const effective: ApprovalDecision = lapsed ? 'deny' : decision;

    this.#pending.delete(id);
    this.#remember(id, effective);

    try {
      entry.resolve(effective);
    } catch (error) {
      warn('approval callback failed', {
        id,
        tool: entry.approval.tool,
        error: describeError(error),
      });
    }

    for (const waiter of [...entry.waiters]) {
      try {
        waiter(effective);
      } catch (error) {
        warn('approval waiter failed', {
          id,
          tool: entry.approval.tool,
          error: describeError(error),
        });
      }
    }
    entry.waiters.clear();
    return !lapsed;
  }

  /**
   * Caduca las aprobaciones cuyo `expiresAt` ya pasó: las resuelve como `deny`
   * (callback incluido) y las quita. Devuelve cuántas caducaron.
   */
  expire(nowMs: number = Date.now()): number {
    let expired = 0;
    for (const [id, entry] of this.#pending) {
      if (entry.approval.expiresAt > nowMs) continue;
      if (this.resolve(id, 'deny')) expired += 1;
    }
    return expired;
  }

  /**
   * Espera la decisión de una aprobación. Sin `timeoutMs` espera hasta su
   * caducidad, de forma que un canal nunca queda esperando para siempre. Al
   * agotarse el plazo se deniega y se limpia la entrada compartida.
   */
  wait(id: string, timeoutMs?: number): Promise<ApprovalDecision> {
    const entry = this.#pending.get(id);
    if (!entry) return Promise.resolve(this.#resolved.get(id) ?? 'deny');

    return new Promise<ApprovalDecision>((resolveWait) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (decision: ApprovalDecision): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        entry.waiters.delete(finish);
        resolveWait(decision);
      };

      entry.waiters.add(finish);

      // La espera nunca sobrevive al TTL: si el plazo pedido es más largo que la
      // caducidad, manda la caducidad.
      const remaining = Math.max(0, entry.approval.expiresAt - Date.now());
      const limit = timeoutMs === undefined ? remaining : timeoutMs;
      const requested = Number.isFinite(limit) ? Math.max(0, limit) : remaining;
      const delay = Math.min(requested, remaining);
      timer = setTimeout(() => {
        // El timeout también resuelve la aprobación compartida: quien la pidió
        // recibe el `deny` y el resto de canales deja de verla pendiente.
        this.resolve(id, 'deny');
        finish('deny');
      }, delay);
      timer.unref?.();
    });
  }

  /** Número de aprobaciones pendientes. */
  get size(): number {
    return this.#pending.size;
  }

  #remember(id: string, decision: ApprovalDecision): void {
    // Se guarda toda decisión, incluida `once`, para que un `wait` tardío
    // conozca lo ya decidido en vez de inventarse un `deny`.
    this.#resolved.delete(id);
    this.#resolved.set(id, decision);
    if (this.#resolved.size > RESOLVED_LIMIT) {
      const oldest = this.#resolved.keys().next().value;
      if (oldest !== undefined) this.#resolved.delete(oldest);
    }
  }
}

/**
 * Instancia que usa el daemon: Telegram y el panel web comparten este singleton
 * para ver y resolver exactamente las mismas aprobaciones pendientes.
 */
export const approvals = new ApprovalBroker();
