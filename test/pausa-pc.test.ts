import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutoupdateDeps } from '../src/autoupdate.js';
import { AUTOUPDATE_PAUSED, autoupdateCommand } from '../src/autoupdate-cli.js';
import { commandFromCallback } from '../src/channels/telegram-shared.js';
import type { Inbound, Outbound } from '../src/channels/types.js';
import type { Lifecycle } from '../src/lifecycle.js';
import { levantarButton, pausaPcButtons, servePausa } from '../src/pausa-cli.js';
import {
  CANCELLED,
  CONFIRM_STALE,
  CONFIRM_TTL_MS,
  comprobarPiezas,
  createPausaConfirm,
  informarLevantado,
  LEVANTAR_FILE,
  NOT_WINDOWS,
  OWNER_ONLY,
  PAUSA_FILE,
  type PausaHelperDeps,
  pausaReply,
  pausedReport,
  readLevantar,
  readPausa,
  runPausaAplicar,
  runPausaLevantar,
  writeLevantar,
  writePausa,
} from '../src/pausa-pc.js';

const dirs: string[] = [];
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), 'pausa-pc-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Fake = PausaHelperDeps & {
  running: Set<string>;
  daemon: 'running' | 'stopped';
  calls: string[];
  notes: string[];
};

function fake(opts: {
  running?: Record<string, string | undefined>;
  stopFails?: boolean;
  killFails?: string[];
  hidagent?: boolean;
  noStart?: boolean;
}): Fake {
  const rutas = new Map(Object.entries(opts.running ?? {}));
  let t = 0;
  const f: Fake = {
    running: new Set(rutas.keys()),
    daemon: 'running',
    calls: [],
    notes: [],
    stopDaemon: async () => {
      f.calls.push('stop');
      if (opts.stopFails) throw new Error('el control no contestó');
      f.daemon = 'stopped';
    },
    startDaemon: async () => {
      f.calls.push('start');
      if (!opts.noStart) f.daemon = 'running';
      return !opts.noStart;
    },
    daemonState: () => f.daemon,
    procesos: async (n) => (f.running.has(n) ? [{ nombre: n, ruta: rutas.get(n) }] : []),
    matar: async (n) => {
      f.calls.push(`kill ${n}`);
      if (opts.killFails?.includes(n))
        return { ok: false, motivo: 'Windows no me deja cerrarlo (se abrió como administrador)' };
      f.running.delete(n);
      return { ok: true };
    },
    matarHidagent: async () => ({ habia: opts.hidagent === true, ok: true }),
    lanzar: async (ruta, args) => {
      f.calls.push(`launch ${ruta} ${args.join(' ')}`);
      f.running.add('uxplay');
      return true;
    },
    notify: async (text) => {
      f.notes.push(text);
    },
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
  };
  return f;
}

describe('confirmación de «⏸️ Parar todo en el PC»', () => {
  const base = {
    isOwnerDm: true,
    platform: 'win32' as const,
    now: () => 1000,
    nonce: () => 'abc123',
  };

  it('solo el dueño en privado y solo en Windows', () => {
    const c = createPausaConfirm();
    expect(c('', [], { ...base, isOwnerDm: false })).toEqual({ kind: 'reply', text: OWNER_ONLY });
    expect(c('', [], { ...base, platform: 'linux' })).toEqual({ kind: 'reply', text: NOT_WINDOWS });
  });

  it('el primer toque pregunta; solo vale el código de ESE aviso y caduca', () => {
    const c = createPausaConfirm();
    const ask = c('pc', ['panel web'], base);
    expect(ask.kind).toBe('ask');
    if (ask.kind === 'ask') expect(ask.text).toContain('• panel web');
    expect(c('confirmar otro', [], base)).toEqual({ kind: 'reply', text: CONFIRM_STALE });
    expect(c('confirmar abc123', [], base)).toEqual({ kind: 'go' });
    // Gastado: un segundo toque ya no para nada.
    expect(c('confirmar abc123', [], base)).toEqual({ kind: 'reply', text: CONFIRM_STALE });
    c('', [], base);
    expect(c('confirmar abc123', [], { ...base, now: () => 1000 + CONFIRM_TTL_MS + 1 })).toEqual({
      kind: 'reply',
      text: CONFIRM_STALE,
    });
    c('', [], base);
    expect(c('cancelar abc123', [], base)).toEqual({ kind: 'reply', text: CANCELLED });
  });

  it('los botones pasan por la lista cerrada de órdenes', () => {
    const [pausa] = pausaPcButtons();
    expect(pausa && commandFromCallback(pausa.action)).toBe('/pausa_pc pc');
    expect(commandFromCallback('cmd:pausa_pc confirmar abc123')).toBe('/pausa_pc confirmar abc123');
    expect(commandFromCallback(levantarButton().action)).toBe('/levantar todo');
    expect(commandFromCallback('cmd:pausa_pc borrar x')).toBeUndefined();
  });
});

describe('pa pausa aplicar', () => {
  it('cierra el daemon limpio, cierra lo de fuera, guarda la ruta y deja arrancado el modo pausa', async () => {
    const d = dir();
    writePausa(d, { since: new Date().toISOString(), activo: ['panel web', 'micrófono'] });
    const f = fake({ running: { uxplay: 'C:\\ux\\uxplay.exe', AsistentaHid: undefined } });
    expect(await runPausaAplicar(d, f)).toBe(0);
    expect(f.calls).toEqual(['stop', 'kill uxplay', 'kill AsistentaHid', 'start']);
    const p = readPausa(d);
    expect(p?.externos).toEqual([
      { id: 'uxplay', ruta: 'C:\\ux\\uxplay.exe' },
      { id: 'hid', ruta: undefined },
    ]);
    expect(p?.avisado).toBe(false);
    const report = pausedReport(p ?? { since: '', activo: [] });
    expect(report).toContain('Parado:');
    expect(report).toContain('panel web, micrófono');
    expect(report).toContain('UxPlay');
    expect(report).not.toContain('No se pudo parar');
  });

  it('lo que no se pudo cerrar sale con su motivo', async () => {
    const d = dir();
    writePausa(d, { since: new Date().toISOString(), activo: [] });
    const f = fake({ running: { uxplay: 'C:\\ux.exe' }, killFails: ['uxplay'], hidagent: true });
    expect(await runPausaAplicar(d, f)).toBe(0);
    const report = pausedReport(readPausa(d) ?? { since: '', activo: [] });
    expect(report).toMatch(
      /No se pudo parar:\n• UxPlay \(pantalla del iPhone\): Windows no me deja cerrarlo/,
    );
    expect(report).toContain('hidagent');
  });

  it('si el daemon no cierra, no hay pausa y lo dice', async () => {
    const d = dir();
    writePausa(d, { since: new Date().toISOString(), activo: [] });
    const f = fake({ running: { uxplay: 'C:\\ux.exe' }, stopFails: true });
    expect(await runPausaAplicar(d, f)).toBe(1);
    expect(readPausa(d)).toBeNull();
    expect(f.calls).toEqual(['stop']);
    expect(f.notes[0]).toContain('no he parado nada');
  });

  it('si el modo pausa no arranca, avisa desde el proceso aparte', async () => {
    const d = dir();
    writePausa(d, { since: new Date().toISOString(), activo: [] });
    const f = fake({ noStart: true });
    expect(await runPausaAplicar(d, f)).toBe(1);
    expect(f.notes[0]).toContain('no consigo arrancar el modo pausa');
    expect(readPausa(d)).not.toBeNull();
  });

  it('sin pausa apuntada no toca nada', async () => {
    const f = fake({});
    expect(await runPausaAplicar(dir(), f)).toBe(0);
    expect(f.calls).toEqual([]);
  });
});

describe('pa pausa levantar', () => {
  it('cierra el modo pausa, quita la pausa, relanza UxPlay con su ruta y arranca el daemon', async () => {
    const d = dir();
    writePausa(d, { since: new Date().toISOString(), activo: [] });
    writeLevantar(d, {
      at: new Date().toISOString(),
      externos: [{ id: 'uxplay', ruta: 'C:\\ux\\uxplay.exe' }, { id: 'hid' }],
      hidagent: true,
    });
    const f = fake({});
    expect(await runPausaLevantar(d, f)).toBe(0);
    expect(readPausa(d)).toBeNull();
    expect(f.calls).toEqual(['stop', 'launch C:\\ux\\uxplay.exe -n Asistenta -nh', 'start']);
    const res = readLevantar(d)?.resultado ?? [];
    expect(res.find((r) => r.nombre.startsWith('UxPlay'))?.ok).toBe(true);
    expect(res.find((r) => r.nombre.startsWith('ayudante'))?.detalle).toContain(
      'al usar el iPhone',
    );
    expect(res.find((r) => r.nombre.startsWith('hidagent'))?.ok).toBe(false);
  });

  it('si el modo pausa no cierra, sigue en pausa', async () => {
    const d = dir();
    writePausa(d, { since: new Date().toISOString(), activo: [] });
    writeLevantar(d, { at: new Date().toISOString(), externos: [] });
    const f = fake({ stopFails: true });
    expect(await runPausaLevantar(d, f)).toBe(1);
    expect(readPausa(d)).not.toBeNull();
    expect(readLevantar(d)).toBeNull();
    expect(f.notes[0]).toContain('sigo en pausa');
  });
});

describe('comprobaciones al levantar', () => {
  it('cada pieza con su estado; la que se cuelga o falla no tapa a las demás', async () => {
    const res = await comprobarPiezas(
      [
        { nombre: 'Panel web', comprobar: async () => ({ ok: true }) },
        { nombre: 'Micrófono', comprobar: () => new Promise(() => {}) },
        {
          nombre: 'OCR',
          comprobar: async () => {
            throw new Error('roto');
          },
        },
      ],
      20,
    );
    expect(res).toEqual([
      { nombre: 'Panel web', ok: true, detalle: undefined },
      { nombre: 'Micrófono', ok: false, detalle: 'no respondió en 0 s' },
      { nombre: 'OCR', ok: false, detalle: 'roto' },
    ]);
  });

  it('el daemon normal informa una sola vez tras levantar', async () => {
    const d = dir();
    writeLevantar(d, {
      at: new Date().toISOString(),
      externos: [],
      resultado: [
        { nombre: 'UxPlay (pantalla del iPhone)', ok: true, detalle: 'abierto otra vez' },
      ],
    });
    const sent: string[] = [];
    const send = async (t: string) => {
      sent.push(t);
    };
    const checks = [
      { nombre: 'Panel web', comprobar: async () => ({ ok: false, detalle: 'no contesta' }) },
    ];
    expect(await informarLevantado(d, checks, send)).toBe(true);
    expect(await informarLevantado(d, checks, send)).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('una pieza no responde');
    expect(sent[0]).toContain('❌ Panel web: no contesta');
    expect(sent[0]).toContain('✅ UxPlay (pantalla del iPhone): abierto otra vez');
  });
});

describe('modo pausa', () => {
  it('un fichero de pausa ilegible sigue contando como pausa', () => {
    const d = dir();
    writeFileSync(join(d, PAUSA_FILE), '{roto');
    expect(readPausa(d)?.activo).toEqual([]);
  });

  it('solo el dueño; «/levantar» lo levanta y lo demás recibe el aviso', () => {
    const st = { since: new Date(0).toISOString(), activo: [] };
    expect(pausaReply({ text: '/levantar todo', isOwnerDm: false }, st, 0)).toEqual({
      kind: 'ignore',
    });
    expect(pausaReply({ text: '/levantar todo', isOwnerDm: true }, st, 0)).toEqual({
      kind: 'levantar',
    });
    expect(pausaReply({ text: 'Levantar', isOwnerDm: true }, st, 0)).toEqual({ kind: 'levantar' });
    const r = pausaReply({ text: 'hola', isOwnerDm: true }, st, 0);
    expect(r.kind).toBe('reply');
  });

  it('servePausa: manda el informe una vez, ignora a otros y lanza levantar con el botón', async () => {
    const d = dir();
    writePausa(d, {
      since: new Date().toISOString(),
      activo: ['panel web'],
      externos: [{ id: 'uxplay', ruta: 'C:\\ux.exe' }],
      resultado: [{ nombre: 'Asistenta por dentro', ok: true }],
      avisado: false,
    });
    const sent: Outbound[] = [];
    let onMessage: ((m: Inbound) => Promise<void> | void) | undefined;
    let lifecycle: Lifecycle | undefined;
    const launched: string[] = [];
    const ready = vi.fn();
    const channel = {
      account: 'main',
      start: async (h: { onMessage: (m: Inbound) => Promise<void> | void }) => {
        onMessage = h.onMessage;
      },
      stop: async () => {},
      send: async (o: Outbound) => {
        sent.push(o);
        return '1';
      },
    };
    const done = servePausa({
      stateDir: d,
      token: 't',
      allowed: [42, 7],
      ownerId: 42,
      channel: channel as never,
      launch: (a) => launched.push(a),
      control: {
        beginResources: () => {},
        attach: (l) => {
          lifecycle = l;
        },
        ready,
      },
    });
    await vi.waitFor(() => expect(ready).toHaveBeenCalled());
    expect(sent[0]?.chatId).toBe('42');
    expect(sent[0]?.text).toContain('⏸️ PC en pausa.');
    expect(sent[0]?.buttons?.[0]?.action).toBe(levantarButton().action);
    expect(readPausa(d)?.avisado).toBe(true);
    const msg = (userId: string, text: string): Inbound =>
      ({
        channel: 'telegram',
        account: 'main',
        chatId: userId,
        userId,
        text,
        authorised: true,
        isGroup: false,
        messageId: '9',
        receivedAt: new Date().toISOString(),
      }) as Inbound;
    await onMessage?.(msg('7', '/levantar todo'));
    expect(launched).toEqual([]);
    expect(sent).toHaveLength(1);
    await onMessage?.(msg('42', '¿qué tal?'));
    expect(sent[1]?.text).toContain('Estoy en pausa');
    await onMessage?.(msg('42', '/levantar todo'));
    expect(launched).toEqual(['levantar']);
    expect(JSON.parse(readFileSync(join(d, LEVANTAR_FILE), 'utf8')).externos).toEqual([
      { id: 'uxplay', ruta: 'C:\\ux.exe' },
    ]);
    await onMessage?.(msg('42', '/levantar todo'));
    expect(launched).toEqual(['levantar']);
    lifecycle?.stop('test');
    expect(await done).toBe(0);
  });
});

describe('autoactualización en pausa', () => {
  it('el vigilante no reinicia para actualizar mientras el PC está en pausa', async () => {
    const d = dir();
    writePausa(d, { since: new Date().toISOString(), activo: [] });
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const code = await autoupdateCommand(['aplicar'], {
        stateDir: d,
        repo: d,
        deps: {} as AutoupdateDeps,
      });
      expect(code).toBe(0);
      expect(out).toHaveBeenCalledWith(`${AUTOUPDATE_PAUSED}\n`);
    } finally {
      out.mockRestore();
    }
  });
});
