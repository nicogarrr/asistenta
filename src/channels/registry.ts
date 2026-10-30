import { EventEmitter } from 'node:events';
import { log } from '../log.js';
import type { ApprovalRequest, ChannelAdapter, ChannelHandlers, Outbound } from './types.js';

/**
 * Adapter registry and the approval broker.
 *
 * Approvals are the one piece of cross-cutting state in the system, so it lives
 * here rather than in each adapter: a request raised by a local cron job has to be
 * answerable from Telegram, and vice versa. Keyed by request id, and every pending
 * request is cleared on expiry so nothing can await forever.
 */
export class ChannelRegistry {
  readonly #adapters = new Map<string, ChannelAdapter>();
  readonly #pending = new Map<string, ApprovalRequest>();
  readonly #events = new EventEmitter();
  #handlers: ChannelHandlers | null = null;

  register(adapter: ChannelAdapter): void {
    // One adapter per (channel, account): a second one on the same credentials is
    // how you end up with a duplicate socket fighting over the same session.
    const key = `${adapter.name}:${adapter.account}`;
    if (this.#adapters.has(key)) {
      throw new Error(`adapter ${key} is already registered`);
    }
    this.#adapters.set(key, adapter);
    log.info('channel registered', { channel: adapter.name, account: adapter.account });
  }

  async startAll(handlers: ChannelHandlers): Promise<void> {
    this.#handlers = handlers;
    const onTvButton = handlers.onTvButton?.bind(handlers);
    const onFuncionesButton = handlers.onFuncionesButton?.bind(handlers);
    for (const adapter of this.#adapters.values()) {
      await adapter.start({
        onMessage: (inbound) => handlers.onMessage(inbound),
        onApprovalNeeded: (req) => this.dispatchApproval(req),
        onPollingLost: (channel, message) => handlers.onPollingLost?.(channel, message),
        onPollingRecovered: (channel) => handlers.onPollingRecovered?.(channel),
        // Los botones del mando de la tele (/tv) llegan por aquí. Antes este objeto
        // no los pasaba y el adaptador veía `onTvButton` vacío: cada pulsación
        // contestaba «Este botón ya no sirve» y no mandaba nada a la tele.
        onTvButton,
        onFuncionesButton,
        log: (level, msg, fields) => log[level](`[${adapter.name}] ${msg}`, fields ?? {}),
      });
      log.info('channel started', { channel: adapter.name });
    }
  }

  async stopAll(strict = false): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#adapters.values()].map((a) => a.stop(strict)),
    );
    const failed = results.some((result) => result.status === 'rejected');
    if (strict && failed) throw new Error('No se pudo confirmar el cierre de todos los canales.');
    this.#adapters.clear();
  }

  get(name: string, account?: string): ChannelAdapter | undefined {
    if (account) return this.#adapters.get(`${name}:${account}`);
    for (const adapter of this.#adapters.values()) if (adapter.name === name) return adapter;
    return undefined;
  }

  all(): ChannelAdapter[] {
    return [...this.#adapters.values()];
  }

  /** Send to every ready adapter matching a channel name. */
  async broadcast(
    outbound: Omit<Outbound, 'channel' | 'account'> & { channel: string },
  ): Promise<void> {
    const targets = [...this.#adapters.values()].filter(
      (a) => a.name === outbound.channel && a.isReady(),
    );
    if (targets.length === 0) {
      log.warn('broadcast had no targets', { channel: outbound.channel, chatId: outbound.chatId });
      return;
    }
    await Promise.allSettled(
      targets.map((a) => a.send({ ...outbound, account: a.account } satisfies Outbound)),
    );
  }

  /**
   * Create a pending approval and auto-expire it. The returned promise is what the
   * gate awaits; a timeout resolves to "not approved" so the gate fails closed.
   */
  requestApproval(req: Omit<ApprovalRequest, 'resolve'>): Promise<boolean> {
    return new Promise<boolean>((resolvePromise) => {
      const entry: ApprovalRequest = { ...req, resolve: resolvePromise };
      this.#pending.set(req.id, entry);
      this.#events.emit('pending', req.id);

      const delay = Math.max(0, new Date(req.expiresAt).getTime() - Date.now());
      const timer = setTimeout(() => {
        if (this.#pending.delete(req.id)) {
          log.warn('approval expired', { id: req.id, tool: req.tool });
          resolvePromise(false);
        }
      }, delay);
      timer.unref();

      // The promise may resolve via resolveApproval before the timer fires.
      const originalResolve = entry.resolve;
      entry.resolve = (approved) => {
        clearTimeout(timer);
        this.#pending.delete(req.id);
        originalResolve(approved);
      };

      void this.dispatchApproval(entry);
    });
  }

  resolveApproval(id: string, approved: boolean): boolean {
    const entry = this.#pending.get(id);
    if (!entry) return false;
    entry.resolve(approved);
    return true;
  }

  pendingApprovals(): ReadonlyArray<Omit<ApprovalRequest, 'resolve'>> {
    return [...this.#pending.values()].map(({ resolve: _resolve, ...rest }) => rest);
  }

  onPendingChange(fn: (count: number) => void): void {
    this.#events.on('pending', () => fn(this.#pending.size));
  }

  /**
   * Offer an approval on every ready channel. Not best-effort in the sense of
   * "ignore failures": if no channel accepts it, the request simply waits for its
   * expiry, which is the correct outcome for a refused-by-inaction gate.
   */
  private async dispatchApproval(req: ApprovalRequest): Promise<void> {
    const targets = this.all().filter((a) => a.isReady());
    if (targets.length === 0) {
      log.warn('approval requested with no ready channel', { id: req.id, tool: req.tool });
      return;
    }
    await this.#handlers?.onApprovalNeeded?.(req);
  }
}
