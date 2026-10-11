import { describe, expect, it } from 'vitest';
import { pairTv, type TvSocket, tvRequest, tvToast } from '../src/tv/lgtv.js';
import { TV_MANIFEST } from '../src/tv/manifest.js';

type Handler = (...args: unknown[]) => void;

class FakeSocket implements TvSocket {
  sent: string[] = [];
  closed = false;
  private onceHandlers = new Map<string, Handler>();
  private messageHandlers: Handler[] = [];

  private readonly failOpen: boolean;

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
    if (event === 'message') this.messageHandlers.push(cb);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  emit(obj: unknown): void {
    for (const cb of this.messageHandlers) cb(JSON.stringify(obj));
  }

  lastSent(): Record<string, unknown> {
    return JSON.parse(this.sent.at(-1) ?? 'null') as Record<string, unknown>;
  }
}

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

function at(sockets: FakeSocket[], i: number): FakeSocket {
  const s = sockets[i];
  if (!s) throw new Error(`socket ${i} no creado`);
  return s;
}

describe('pairTv', () => {
  it('registra con PROMPT + manifest y devuelve la client-key del registered', async () => {
    const sockets: FakeSocket[] = [];
    const { urls, factory } = factoryTracking(sockets);
    const pending = pairTv('192.168.1.237', { factory });
    await new Promise((r) => setImmediate(r));
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
    await expect(pending).resolves.toBe('KEY123');
    expect(tv.closed).toBe(true);
  });

  it('cae a ws://3000 si wss://3001 no abre', async () => {
    const sockets: FakeSocket[] = [];
    const urls: string[] = [];
    const factory = (url: string): TvSocket => {
      urls.push(url);
      const s = new FakeSocket(urls.length === 1);
      sockets.push(s);
      return s;
    };
    const pending = pairTv('192.168.1.237', { factory });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(urls).toEqual(['wss://192.168.1.237:3001', 'ws://192.168.1.237:3000']);
    at(sockets, 1).emit({
      type: 'registered',
      id: 'register_0',
      payload: { 'client-key': 'KEY9' },
    });
    await expect(pending).resolves.toBe('KEY9');
  });

  it('rechaza si la tele responde error al registro', async () => {
    const sockets: FakeSocket[] = [];
    const { factory } = factoryTracking(sockets);
    const pending = pairTv('192.168.1.237', { factory });
    await new Promise((r) => setImmediate(r));
    at(sockets, 0).emit({ type: 'error', id: 'register_0', error: '401 insufficient permissions' });
    await expect(pending).rejects.toThrow(/rechazo el registro/);
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
    await new Promise((r) => setImmediate(r));
    const tv = at(sockets, 0);
    tv.emit({ type: 'registered', id: 'register_0', payload: { 'client-key': 'KEY123' } });
    await new Promise((r) => setImmediate(r));
    const req = tv.lastSent() as { type: string; id: string; uri: string; payload: unknown };
    expect(req.type).toBe('request');
    expect(req.uri).toBe('ssap://system.notifications/createToast');
    expect(req.payload).toEqual({ message: 'hola' });
    tv.emit({ type: 'response', id: req.id, payload: { returnValue: true } });
    await expect(pending).resolves.toEqual({ returnValue: true });
    expect(tv.closed).toBe(true);
  });

  it('rechaza si la tele devuelve error en el request', async () => {
    const sockets: FakeSocket[] = [];
    const { factory } = factoryTracking(sockets);
    const pending = tvToast('192.168.1.237', 'KEY123', 'hola', { factory });
    await new Promise((r) => setImmediate(r));
    const tv = at(sockets, 0);
    tv.emit({ type: 'registered', id: 'register_0', payload: { 'client-key': 'KEY123' } });
    await new Promise((r) => setImmediate(r));
    const req = tv.lastSent() as { id: string };
    tv.emit({ type: 'error', id: req.id, error: '404 no such service' });
    await expect(pending).rejects.toThrow(/createToast/);
  });
});
