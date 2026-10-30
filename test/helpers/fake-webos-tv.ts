// Tele webOS falsa para tests (opcion unknownKey para el re-emparejado).
/**
 * Tele LG webOS simulada para tests: habla SSAP sobre la interfaz TvSocket
 * de src/tv/lgtv.ts (sin red, sin tele real). Cada socket abre (o falla, si
 * la tele esta "apagada"), contesta al register con la client-key esperada y
 * responde a los requests segun `handlers`. Registra todo lo recibido para
 * poder fijar el comportamiento observable del cliente.
 */
import type {
  TvInputSocket,
  TvInputSocketFactory,
  TvSocket,
  TvSocketFactory,
} from '../../src/tv/lgtv.js';

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
  /**
   * Socket de input de botones (tvKey): 'open' abre y acepta; 'hang' nunca
   * abre; 'error' falla al abrir; 'close-early' cierra justo tras recibir la
   * tecla (antes del margen de consumo).
   */
  inputMode?: 'open' | 'hang' | 'error' | 'close-early';
  /**
   * Que hace la tele ante una client-key que no conoce: 'error' (por defecto,
   * 401), 'prompt' (muestra el aviso de emparejamiento y nadie lo acepta) o
   * 'prompt-accept' (muestra el aviso y Nico lo acepta: entrega SU clave).
   */
  unknownKey?: 'error' | 'prompt' | 'prompt-accept';
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

// unknownKey: ver FakeTvOptions (re-emparejado, lane tv7).
export class FakeWebOsTv {
  readonly urls: string[] = [];
  readonly requests: FakeTvRequest[] = [];
  readonly registers: Array<string | undefined> = [];
  sockets: FakeTvSocket[] = [];
  /** Urls de los sockets de input pedidos y botones recibidos (en orden). */
  readonly inputUrls: string[] = [];
  readonly buttons: string[] = [];
  inputSockets: FakeTvInputSocket[] = [];
  opts: Required<Omit<FakeTvOptions, 'handlers'>> & {
    handlers: NonNullable<FakeTvOptions['handlers']>;
  };

  constructor(opts: FakeTvOptions = {}) {
    this.opts = {
      clientKey: opts.clientKey ?? 'KEY123',
      reachable: opts.reachable ?? true,
      failOpens: opts.failOpens ?? 0,
      openFailure: opts.openFailure ?? 'error',
      inputMode: opts.inputMode ?? 'open',
      unknownKey: opts.unknownKey ?? 'error',
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

  /** Factory del socket de input de botones, para `deps.inputFactory`. */
  get inputFactory(): TvInputSocketFactory {
    return (url: string): TvInputSocket => {
      this.inputUrls.push(url);
      const s = new FakeTvInputSocket(this, this.opts.inputMode);
      this.inputSockets.push(s);
      return s;
    };
  }

  /** Todos los sockets abiertos terminaron cerrados (sin fugas). */
  allClosed(): boolean {
    return (
      this.sockets.every((s) => s.closed || s.terminated) &&
      this.inputSockets.every((s) => s.closed)
    );
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
        if (this.opts.unknownKey === 'error') {
          socket.reply({ type: 'error', id: msg.id, error: '401 insufficient permissions' });
          return;
        }
        // Tele real: la clave desconocida se trata como emparejamiento nuevo.
        socket.reply({
          type: 'response',
          id: msg.id,
          payload: { pairingType: 'PROMPT', returnValue: true },
        });
        if (this.opts.unknownKey === 'prompt') return;
        queueMicrotask(() =>
          socket.reply({
            type: 'registered',
            id: msg.id,
            payload: { 'client-key': this.opts.clientKey },
          }),
        );
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
      if (!h && uri === 'com.webos.service.networkinput/getPointerInputSocket') {
        const host = new URL(this.urls[this.urls.length - 1] ?? 'wss://127.0.0.1:3001').hostname;
        socket.reply({
          type: 'response',
          id: msg.id,
          payload: { returnValue: true, socketPath: `wss://${host}:3001/resources/input` },
        });
        return;
      }
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

export class FakeTvInputSocket implements TvInputSocket {
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, Handler[]>();
  private readonly tv: FakeWebOsTv;
  private readonly mode: 'open' | 'hang' | 'error' | 'close-early';

  constructor(tv: FakeWebOsTv, mode: 'open' | 'hang' | 'error' | 'close-early') {
    this.tv = tv;
    this.mode = mode;
    queueMicrotask(() => {
      if (mode === 'hang') return;
      if (mode === 'error') this.emit('error', new Error('connect ECONNREFUSED'));
      else this.emit('open');
    });
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }

  on(event: string, cb: Handler): void {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
  }

  send(data: string): void {
    this.sent.push(data);
    const m = /^type:button\nname:([A-Z0-9_]+)\n\n$/.exec(data);
    if (m?.[1]) this.tv.buttons.push(m[1]);
    if (this.mode === 'close-early') queueMicrotask(() => this.close());
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}
