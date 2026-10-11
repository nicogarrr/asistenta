import { describe, expect, it } from 'vitest';
import { pairTv, type TvSocket, tvRequest, tvToast } from '../src/tv/lgtv.js';
import { TV_MANIFEST } from '../src/tv/manifest.js';

type Handler = (...args: unknown[]) => void;

class FakeSocket implements TvSocket {
  sent: string[] = [];
  closed = false;
  terminated = false;
  private readonly failOpen: boolean;
  private onceHandlers = new Map<string, Handler>();
  private listeners = new Map<string, Handler[]>();

  constructor(failOpen = false) {
    this.failOpen = failOpen;
    queueMicrotask(() => {
      if (this.failOpen) this.onceHandlers.get('error')?.(new Error('connection refused'));
      else this.onceHandlers.get('open')?.();
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
  }

  close(): void {
    this.closed = true;
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(obj: unknown): void {
    for (const cb of this.listeners.get('message') ?? []) cb(JSON.stringify(obj));
  }

  lastSent(): Record<string, unknown> {
    return JSON.parse(this.sent.at(-1) ?? 'null') as Record<string, unknown>;
  }
}

function at(sockets: FakeSocket[], i: number): FakeSocket {
  const s = sockets[i];
  if (!s) throw new Error(`socket ${i} no creado`);
  return s;
}

const tick = () => new Promise((r) => setImmediate(r));

function factoryTracking(sockets: FakeSocket[]) {
  const urls: string[] = [];
  return {
    urls,
    factory: (url: string): TvSocket => {
      urls.push(url);
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
  };
}

describe('pairTv', () => {
  it('registra con PROMPT + manifest y devuelve la client-key del registered', async () => {
    const sockets: FakeSocket[] = [];
    const { urls, factory } = factoryTracking(sockets);
    const pending = pairTv('192.168.1.237', { factory });
    await tick();
    const tv = at(sockets, 0);
    const registerMsg = tv.lastSent() as {
      type: string;
      payload: { pairingType: string; manifest: unknown; 'client-key'?: string };
    };
    expect(urls).toEqual(['wss://192.168.1.237:3001']);
    expect(registerMsg.type).toBe('register');
    expect(registerMsg.payload.pairingType).toBe('PROMPT');
    expect(registerMsg.payload.manifest).toEqual(TV_MANIFEST);
    expect(registerMsg.payload['client-key']).toBeUndefined();
    tv.emit({ type: 'response', id: 'register_0', payload: { pairingType: 'PROMPT' } });
    tv.emit({ type: 'registered', id: 'register_0', payload: { 'client-key': 'KEY123' } });
    await expect(pending).resolves.toEqual({ clientKey: 'KEY123', secure: true });
    expect(tv.closed).toBe(true);
  });

  it('cae a ws://3000 si wss://3001 no abre (y lo marca NO seguro)', async () => {
    const sockets: FakeSocket[] = [];
    const urls: string[] = [];
    const factory = (url: string): TvSocket => {
      urls.push(url);
      const s = new FakeSocket(urls.length === 1);
      sockets.push(s);
      return s;
    };
    const pending = pairTv('192.168.1.237', { factory });
    await tick();
    await tick();
    expect(urls).toEqual(['wss://192.168.1.237:3001', 'ws://192.168.1.237:3000']);
    at(sockets, 1).emit({
      type: 'registered',
      id: 'register_0',
      payload: { 'client-key': 'KEY9' },
    });
    await expect(pending).resolves.toEqual({ clientKey: 'KEY9', secure: false });
  });

  it('rechaza si la tele responde error al registro', async () => {
    const sockets: FakeSocket[] = [];
    const { factory } = factoryTracking(sockets);
    const pending = pairTv('192.168.1.237', { factory });
    await tick();
    at(sockets, 0).emit({ type: 'error', id: 'register_0', error: '401 insufficient permissions' });
    await expect(pending).rejects.toThrow(/rechazo el registro/);
  });

  it('ignora JSON malformado o null sin lanzar fuera del Promise', async () => {
    const sockets: FakeSocket[] = [];
    const { factory } = factoryTracking(sockets);
    const pending = pairTv('192.168.1.237', { factory });
    await tick();
    const tv = at(sockets, 0);
    for (const cb of (tv as unknown as { listeners: Map<string, Handler[]> })['listeners'].get(
      'message',
    ) ?? []) {
      cb('esto no es json{');
      cb('null');
    }
    tv.emit({ type: 'registered', id: 'register_0', payload: { 'client-key': 'KEYOK' } });
    await expect(pending).resolves.toEqual({ clientKey: 'KEYOK', secure: true });
  });

  it('rechaza host que no es IP de LAN antes de conectar', async () => {
    let called = 0;
    await expect(
      pairTv('http://evil.example/x@y', {
        factory: () => {
          called += 1;
          return new FakeSocket();
        },
      }),
    ).rejects.toThrow(/no valido/);
    expect(called).toBe(0);
  });
});

describe('tvRequest', () => {
  it('registra con client-key y envia el request con uri ssap y payload', async () => {
    const sockets: FakeSocket[] = [];
    const { factory } = factoryTracking(sockets);
    const pending = tvRequest(
      '192.168.1.237',
      'KEY123',
      'system.notifications/createToast',
      { message: 'hola' },
      { factory },
    );
    await tick();
    const tv = at(sockets, 0);
    tv.emit({ type: 'registered', id: 'register_0', payload: { 'client-key': 'KEY123' } });
    await tick();
    const req = tv.lastSent() as { type: string; id: string; uri: string; payload: unknown };
    expect(req.type).toBe('request');
    expect(req.uri).toBe('ssap://system.notifications/createToast');
    expect(req.payload).toEqual({ message: 'hola' });
    tv.emit({ type: 'response', id: req.id, payload: { returnValue: true } });
    await expect(pending).resolves.toEqual({ returnValue: true });
    expect(tv.closed).toBe(true);
  });

  it('SIN downgrade por defecto: con clave guardada solo prueba wss', async () => {
    const sockets: FakeSocket[] = [];
    const { urls, factory } = factoryTracking(sockets);
    const pending = tvToast('192.168.1.237', 'KEY123', 'hola', { factory });
    await tick();
    expect(urls).toEqual(['wss://192.168.1.237:3001']);
    const tv = at(sockets, 0);
    tv.emit({ type: 'registered', id: 'register_0', payload: { 'client-key': 'KEY123' } });
    await tick();
    const req = tv.lastSent() as { id: string };
    tv.emit({ type: 'response', id: req.id, payload: { returnValue: true } });
    await expect(pending).resolves.toBeUndefined();
  });

  it('rechaza si la tele devuelve error en el request', async () => {
    const sockets: FakeSocket[] = [];
    const { factory } = factoryTracking(sockets);
    const pending = tvToast('192.168.1.237', 'KEY123', 'hola', { factory });
    await tick();
    const tv = at(sockets, 0);
    tv.emit({ type: 'registered', id: 'register_0', payload: { 'client-key': 'KEY123' } });
    await tick();
    const req = tv.lastSent() as { id: string };
    tv.emit({ type: 'error', id: req.id, error: '404 no such service' });
    await expect(pending).rejects.toThrow(/createToast/);
  });
});
