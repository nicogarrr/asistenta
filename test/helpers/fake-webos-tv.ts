/**
 * Tele LG webOS simulada para tests: habla SSAP sobre la interfaz TvSocket
 * de src/tv/lgtv.ts (sin red, sin tele real). Cada socket abre (o falla, si
 * la tele esta "apagada"), contesta al register con la client-key esperada y
 * responde a los requests segun `handlers`. Registra todo lo recibido para
 * poder fijar el comportamiento observable del cliente.
 */
import type { TvSocket, TvSocketFactory } from '../../src/tv/lgtv.js';

type Handler = (...args: unknown[]) => void;

export interface FakeTvOptions {
  /** Client-key que la tele acepta (por defecto KEY123). */
  clientKey?: string;
  /** false = la tele no abre el socket (apagada / fuera de red). */
  reachable?: boolean;
  /** Cuantas aperturas fallan antes de empezar a abrir (tele arrancando). */
  failOpens?: number;
  /** Como falla la apertura: error inmediato o sin respuesta (timeout). */
  openFailure?: 'error' | 'hang' | 'close';
  /** Respuestas por uri (sin ssap://). Devuelve payload; lanzar = error SSAP. */
  handlers?: Record<
    string,
    (payload: Record<string, unknown>) => Record<string, unknown> | 'silent'
  >;
}

export interface FakeTvRequest {
  uri: string;
  payload: Record<string, unknown>;
}

export class FakeWebOsTv {
  readonly urls: string[] = [];
  readonly requests: FakeTvRequest[] = [];
  readonly registers: Array<string | undefined> = [];
  sockets: FakeTvSocket[] = [];
  opts: Required<Omit<FakeTvOptions, 'handlers'>> & {
    handlers: NonNullable<FakeTvOptions['handlers']>;
  };

  constructor(opts: FakeTvOptions = {}) {
    this.opts = {
      clientKey: opts.clientKey ?? 'KEY123',
      reachable: opts.reachable ?? true,
      failOpens: opts.failOpens ?? 0,
      openFailure: opts.openFailure ?? 'error',
      handlers: opts.handlers ?? {},
    };
  }

  get factory(): TvSocketFactory {
    return (url: string): TvSocket => {
      this.urls.push(url);
      let fail = !this.opts.reachable;
      if (!fail && this.opts.failOpens > 0) {
        this.opts.failOpens -= 1;
        fail = true;
      }
      const s = new FakeTvSocket(this, fail ? this.opts.openFailure : 'open');
      this.sockets.push(s);
      return s;
    };
  }

  /** Todos los sockets abiertos terminaron cerrados (sin fugas). */
  allClosed(): boolean {
    return this.sockets.every((s) => s.closed || s.terminated);
  }

  handle(socket: FakeTvSocket, raw: string): void {
    const msg = JSON.parse(raw) as {
      type: string;
      id: string;
      uri?: string;
      payload?: Record<string, unknown>;
    };
    if (msg.type === 'register') {
      const key = msg.payload?.['client-key'] as string | undefined;
      this.registers.push(key);
      if (key !== undefined && key !== this.opts.clientKey) {
        socket.reply({ type: 'error', id: msg.id, error: '401 insufficient permissions' });
        return;
      }
      socket.reply({
        type: 'registered',
        id: msg.id,
        payload: { 'client-key': this.opts.clientKey },
      });
      return;
    }
    if (msg.type === 'request') {
      const uri = String(msg.uri ?? '').replace(/^ssap:\/\//, '');
      const payload = msg.payload ?? {};
      this.requests.push({ uri, payload });
      const h = this.opts.handlers[uri];
      if (!h) {
        socket.reply({ type: 'response', id: msg.id, payload: { returnValue: true } });
        return;
      }
      let out: Record<string, unknown> | 'silent';
      try {
        out = h(payload);
      } catch (err) {
        socket.reply({ type: 'error', id: msg.id, error: (err as Error).message });
        return;
      }
      if (out === 'silent') return;
      socket.reply({ type: 'response', id: msg.id, payload: out });
    }
  }
}

export class FakeTvSocket implements TvSocket {
  sent: string[] = [];
  closed = false;
  terminated = false;
  private onceHandlers = new Map<string, Handler>();
  private listeners = new Map<string, Handler[]>();

  private readonly tv: FakeWebOsTv;

  constructor(tv: FakeWebOsTv, mode: 'open' | 'error' | 'hang' | 'close') {
    this.tv = tv;
    queueMicrotask(() => {
      if (mode === 'open') this.onceHandlers.get('open')?.();
      else if (mode === 'error')
        this.onceHandlers.get('error')?.(new Error('connect ECONNREFUSED'));
      else if (mode === 'close') for (const cb of this.listeners.get('close') ?? []) cb();
    });
  }

  once(event: string, cb: Handler): void {
    this.onceHandlers.set(event, cb);
  }

  on(event: string, cb: Handler): void {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
  }

  off(event: string, cb: Handler): void {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((h) => h !== cb),
    );
  }

  send(data: string): void {
    this.sent.push(data);
    queueMicrotask(() => this.tv.handle(this, data));
  }

  reply(obj: unknown): void {
    if (this.closed) return;
    for (const cb of this.listeners.get('message') ?? []) cb(JSON.stringify(obj));
  }

  close(): void {
    this.closed = true;
  }

  terminate(): void {
    this.terminated = true;
  }
}
