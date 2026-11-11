import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { type IdleClient, MailIdleTransport, type ReadMailAccount } from '../src/mail/idle.js';
import {
  necesitaIdle,
  setVigilarLigero,
  textoVigilar,
  trasAvisos,
  VIGILAR_LIGERO_KEY,
  vigilarLigero,
  vigilarOrden,
} from '../src/mail/vigilar-ligero.js';

const account = {
  address: 'nico@gmail.com',
  password: 'abcdefghijklmnop',
  imapHost: 'imap.gmail.com',
  imapPort: 993,
} as unknown as ReadMailAccount;

class Mock extends EventEmitter {
  capabilities = new Map<string, unknown>([['IDLE', true]]);
  box = { uidValidity: 1n, uidNext: 5, readOnly: true };
  connect = vi.fn(async () => {});
  mailboxOpen = vi.fn(async () => ({ ...this.box }));
  search = vi.fn(async () => [] as number[]);
  fetchOne = vi.fn(async () => null);
  private done: (() => void) | null = null;
  idle = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        this.done = () => resolve(true);
      }),
  );
  close = vi.fn(() => {
    this.emit('close');
    this.done?.();
  });
}
const tick = async (n = 40) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

const kv = () => {
  const m = new Map<string, string>();
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => m.set(k, v), m };
};

describe('gaps-17: «/correo vigilar on|off» — IDLE solo para invitaciones y recordatorios', () => {
  it('la orden: on/off/estado y nada más', () => {
    expect(vigilarOrden('vigilar on')).toBe('on');
    expect(vigilarOrden('vigilar  encender')).toBe('on');
    expect(vigilarOrden('Vigilar OFF')).toBe('off');
    expect(vigilarOrden('vigilar apaga')).toBe('off');
    expect(vigilarOrden('vigilar')).toBe('estado');
    expect(vigilarOrden('vigilancia')).toBe('estado');
    // Lo demás de /correo sigue igual.
    expect(vigilarOrden('estado')).toBeNull();
    expect(vigilarOrden('lista')).toBeNull();
    expect(vigilarOrden('vigilar a Marta')).toBeNull();
  });

  it('nace apagado y se guarda', () => {
    const k = kv();
    expect(vigilarLigero(k)).toBe(false);
    setVigilarLigero(k, true);
    expect(k.m.get(VIGILAR_LIGERO_KEY)).toBe('on');
    expect(vigilarLigero(k)).toBe(true);
    setVigilarLigero(k, false);
    expect(vigilarLigero(k)).toBe(false);
    // Un almacén roto no lo enciende.
    expect(
      vigilarLigero({
        get: () => {
          throw new Error('x');
        },
        set: () => {},
      }),
    ).toBe(false);
  });

  it('IDLE hace falta con el ojo, un disparador o el aviso ligero; sin nada, no', () => {
    const no = { ojo: false, disparador: false, ligero: false };
    expect(necesitaIdle(no)).toBe(false);
    expect(necesitaIdle({ ...no, ligero: true })).toBe(true);
    expect(necesitaIdle({ ...no, disparador: true })).toBe(true);
    expect(necesitaIdle({ ...no, ojo: true })).toBe(true);
  });

  it('con el aviso ligero el correo se da por leído (no se rechaza ni va al ojo)', () => {
    const no = { ojo: false, disparador: false, ligero: false };
    // Antes: sin ojo ni disparador se rechazaba y el cursor no avanzaba (reintentos).
    expect(trasAvisos(no)).toBe('rechazar');
    expect(trasAvisos({ ...no, ligero: true })).toBe('leido');
    expect(trasAvisos({ ...no, disparador: true })).toBe('leido');
    // El ojo manda: si está, el correo va a la cola de atención como siempre.
    expect(trasAvisos({ ojo: true, disparador: false, ligero: true })).toBe('ojo');
  });

  it('textos: dice qué mira, que no gasta modelo, y si falta la cuenta', () => {
    const no = { ojo: false, disparador: false, ligero: false };
    const on = textoVigilar({ orden: 'on', on: true, cuenta: true, otros: no });
    expect(on).toContain('invitaciones de calendario');
    expect(on).toContain('recordatorios por tema');
    expect(on).toContain('ni gasto modelo');
    expect(on).not.toContain('/correo estado');
    expect(textoVigilar({ orden: 'on', on: true, cuenta: false, otros: no })).toContain(
      '«/correo estado»',
    );
    expect(textoVigilar({ orden: 'off', on: false, cuenta: true, otros: no })).toContain(
      'ya no miro el correo nuevo',
    );
    // Apagar el ligero con el ojo encendido: el correo se sigue mirando, y lo dice.
    expect(
      textoVigilar({ orden: 'off', on: false, cuenta: true, otros: { ...no, ojo: true } }),
    ).toContain('Sigo mirando el correo nuevo porque lo usa el ojo');
    expect(textoVigilar({ orden: 'estado', on: false, cuenta: true, otros: no })).toContain(
      '«/correo vigilar on»',
    );
  });

  it('MailIdleTransport.pause() apaga la conexión y start() la vuelve a abrir', async () => {
    const clients: Mock[] = [];
    const states: string[] = [];
    const t = new MailIdleTransport({
      account: async () => account,
      load: () => null,
      save: () => {},
      deliver: async () => {},
      factory: () => {
        const c = new Mock();
        clients.push(c);
        return c as unknown as IdleClient;
      },
      status: (s) => states.push(s),
    });
    t.start();
    await tick();
    expect(t.running()).toBe(true);
    expect(clients).toHaveLength(1);
    await t.pause();
    expect(t.running()).toBe(false);
    expect(clients[0]?.close).toHaveBeenCalled();
    expect(states).toContain('stopped');
    t.start();
    await tick();
    expect(t.running()).toBe(true);
    expect(clients).toHaveLength(2);
    expect(clients[1]?.connect).toHaveBeenCalled();
    // stop() sigue siendo definitivo: tras él, start() no reabre.
    await t.stop();
    t.start();
    await tick();
    expect(clients).toHaveLength(2);
    expect(t.running()).toBe(false);
  });

  it('el daemon: arranca IDLE con el aviso ligero, y /correo vigilar lo enciende y apaga', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toContain('if (necesitaIdle(motivosIdle())) mailIdle.start();');
    expect(cli).toContain("if (paso === 'leido') return;");
    expect(cli).toMatch(/const vigilar = vigilarOrden\(args\);[\s\S]{0,400}mailIdle\.pause\(\)/);
  });
});
