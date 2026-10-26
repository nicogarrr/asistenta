import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalBroker, approvals } from '../src/approvals/broker.js';
import { log } from '../src/log.js';

type Registration = Parameters<ApprovalBroker['register']>[0];

/** Entrada mínima; cada prueba cambia solo lo que le importa. */
function registration(overrides: Partial<Registration> = {}): Registration {
  return {
    tool: 'shell',
    reason: 'comando destructivo',
    question: '¿Permito shell?',
    resolve: () => {},
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('registro, listado y consulta', () => {
  it('registra con id aleatorio y TTL por defecto de cinco minutos', () => {
    const broker = new ApprovalBroker();
    const before = Date.now();
    const approval = broker.register(registration());
    const after = Date.now();

    expect(approval.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(approval.createdAt).toBeGreaterThanOrEqual(before);
    expect(approval.createdAt).toBeLessThanOrEqual(after);
    expect(approval.expiresAt - approval.createdAt).toBe(300_000);
    expect(broker.get(approval.id)).toEqual(approval);
  });

  it('lista todas las pendientes y filtra por chatId', () => {
    const broker = new ApprovalBroker();
    const telegram = broker.register(registration({ chatId: 'tg:1' }));
    const web = broker.register(registration({ chatId: 'web:1', threadId: '9' }));

    expect(broker.list().map((approval) => approval.id)).toEqual([telegram.id, web.id]);
    expect(broker.list({ chatId: 'tg:1' })).toEqual([telegram]);
    expect(broker.list({ chatId: 'inexistente' })).toEqual([]);
    expect(broker.size).toBe(2);
  });

  it('get devuelve undefined para un id desconocido', () => {
    const broker = new ApprovalBroker();
    expect(broker.get('no-existe')).toBeUndefined();
  });
});

describe('resolución', () => {
  it('resuelve una sola vez, limpia la entrada y llama al callback', () => {
    const broker = new ApprovalBroker();
    const callback = vi.fn();
    const approval = broker.register(registration({ resolve: callback }));

    expect(broker.resolve(approval.id, 'session')).toBe(true);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith('session');
    expect(broker.get(approval.id)).toBeUndefined();
    expect(broker.list()).toEqual([]);
    expect(broker.size).toBe(0);

    // El segundo canal que pulsa tarde no vuelve a decidir ni a llamar al callback.
    expect(broker.resolve(approval.id, 'deny')).toBe(false);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('wait resuelve con la decisión tomada por otro canal', async () => {
    const broker = new ApprovalBroker();
    const approval = broker.register(registration());
    const waiting = broker.wait(approval.id, 1_000);

    expect(broker.resolve(approval.id, 'always')).toBe(true);
    await expect(waiting).resolves.toBe('always');
  });

  it('un wait posterior conserva la decisión ya tomada (incluida once)', async () => {
    const broker = new ApprovalBroker();
    const approval = broker.register(registration());

    broker.resolve(approval.id, 'once');
    await expect(broker.wait(approval.id, 1_000)).resolves.toBe('once');
  });

  it('el timeout de wait deniega y limpia la aprobación compartida', async () => {
    vi.useFakeTimers();
    const broker = new ApprovalBroker();
    const callback = vi.fn();
    const approval = broker.register(registration({ ttlMs: 60_000, resolve: callback }));

    const waiting = broker.wait(approval.id, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(waiting).resolves.toBe('deny');
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith('deny');
    expect(broker.size).toBe(0);
    expect(broker.get(approval.id)).toBeUndefined();
  });

  it('expire niega y quita solo las caducadas', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const broker = new ApprovalBroker();
    const expiredCallback = vi.fn();
    const liveCallback = vi.fn();
    const expired = broker.register(registration({ ttlMs: 1_000, resolve: expiredCallback }));
    const live = broker.register(registration({ ttlMs: 5_000, resolve: liveCallback }));

    expect(broker.expire(1_000_999)).toBe(0);
    expect(broker.expire(1_001_000)).toBe(1);

    expect(expiredCallback).toHaveBeenCalledWith('deny');
    expect(liveCallback).not.toHaveBeenCalled();
    expect(broker.get(expired.id)).toBeUndefined();
    expect(broker.get(live.id)).toEqual(live);
    expect(broker.size).toBe(1);
  });

  it('un callback que lanza no rompe resolve ni deja colgado a wait', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const broker = new ApprovalBroker();
    const approval = broker.register(
      registration({
        resolve: () => {
          throw new Error('callback roto');
        },
      }),
    );

    const waiting = broker.wait(approval.id, 1_000);
    expect(() => broker.resolve(approval.id, 'deny')).not.toThrow();
    await expect(waiting).resolves.toBe('deny');
    expect(broker.resolve(approval.id, 'deny')).toBe(false);
    expect(broker.size).toBe(0);
    expect(warn).toHaveBeenCalled();
  });
});

describe('singleton del daemon', () => {
  it('exporta una instancia compartida de ApprovalBroker', () => {
    expect(approvals).toBeInstanceOf(ApprovalBroker);
  });
});
