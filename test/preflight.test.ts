import { describe, expect, it, vi } from 'vitest';
import { iniciarCommand, parseIniciarArgs } from '../src/iniciar.js';
import {
  formatPreflight,
  type PreflightDeps,
  preflightExitCode,
  runPreflight,
} from '../src/preflight.js';
import { checkTelegramToken } from '../src/startup.js';

const GB = 1024 ** 3;

/** Un PC de Nico en el que todo está bien. Cada test rompe una cosa. */
function deps(
  over: Partial<PreflightDeps> = {},
  vault: Record<string, string> = {},
): PreflightDeps {
  const store: Record<string, string> = {
    'telegram:botToken': '123:abc',
    'telegram:allowedUserIds': '42',
    'tv:host': '192.168.1.50',
    ...vault,
  };
  return {
    nodeVersion: 'v24.3.0',
    platform: 'win32',
    vaultExists: () => true,
    unlock: async () => {},
    vaultGet: async (k) => store[k],
    checkTelegramToken: async () => {},
    checkProvider: async () => {},
    providerFailureMessage: () => 'Falta la clave del proveedor.',
    tvReachable: async () => true,
    desktopEnabled: () => true,
    computerUseEnabled: () => true,
    mailStatus: async () => ({ read: 'ok', send: 'ok' }),
    freeDiskBytes: async () => 20 * GB,
    ...over,
  };
}

const byId = async (d: PreflightDeps) =>
  Object.fromEntries((await runPreflight(d)).map((c) => [c.id, c]));

describe('runPreflight', () => {
  it('todo bien: todo en verde y código 0', async () => {
    const checks = await runPreflight(deps());
    expect(checks.map((c) => c.id)).toEqual([
      'node',
      'vault',
      'telegram',
      'usuarios',
      'modelo',
      'tele',
      'pc',
      'correo',
      'disco',
    ]);
    expect(checks.every((c) => c.status === 'ok')).toBe(true);
    expect(preflightExitCode(checks)).toBe(0);
    expect(formatPreflight(checks)).toContain('Todo listo para arrancar.');
  });

  it('sin vault: falla con el arreglo y no lee nada de él', async () => {
    const vaultGet = vi.fn(async () => 'x');
    const c = await byId(deps({ vaultExists: () => false, vaultGet }));
    expect(c.vault?.status).toBe('fallo');
    expect(c.vault?.hint).toMatch(/pa vault init/);
    expect(c.telegram?.status).toBe('fallo');
    expect(vaultGet).not.toHaveBeenCalled();
  });

  it('vault que no se abre: fallo, nunca revienta', async () => {
    const c = await byId(
      deps({
        unlock: async () => {
          throw new Error('DPAPI: clave no válida');
        },
      }),
    );
    expect(c.vault?.status).toBe('fallo');
    expect(c.vault?.detail).toContain('DPAPI');
  });

  it('token de Telegram no válido (401 de Telegram simulado): fallo con el mensaje en español', async () => {
    const fakeFetch = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    const c = await byId(deps({ checkTelegramToken: (t) => checkTelegramToken(t, fakeFetch) }));
    expect(c.telegram?.status).toBe('fallo');
    expect(c.telegram?.detail).toMatch(/no es válido/);
    expect(c.telegram?.hint).toBeTruthy();
  });

  it('token válido (getMe ok simulado): verde', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ ok: true, result: { id: 1 } }), {
        status: 200,
      })) as unknown as typeof fetch;
    const c = await byId(deps({ checkTelegramToken: (t) => checkTelegramToken(t, fakeFetch) }));
    expect(c.telegram?.status).toBe('ok');
  });

  it('sin token ni usuarios: dos fallos con su comando de arreglo', async () => {
    const c = await byId(deps({}, { 'telegram:botToken': '', 'telegram:allowedUserIds': 'x,0' }));
    expect(c.telegram?.status).toBe('fallo');
    expect(c.telegram?.hint).toMatch(/telegram:botToken/);
    expect(c.usuarios?.status).toBe('fallo');
    expect(c.usuarios?.hint).toMatch(/telegram:allowedUserIds/);
  });

  it('sin clave del modelo: fallo con el mensaje de startup', async () => {
    const c = await byId(
      deps({
        checkProvider: async () => {
          throw new Error('no API key');
        },
      }),
    );
    expect(c.modelo?.status).toBe('fallo');
    expect(c.modelo?.detail).toBe('Falta la clave del proveedor.');
  });

  it('la tele es opcional: sin emparejar es info; emparejada y sin responder es aviso, no fallo', async () => {
    expect((await byId(deps({}, { 'tv:host': '' }))).tele?.status).toBe('info');
    const c = await byId(deps({ tvReachable: async () => false }));
    expect(c.tele?.status).toBe('aviso');
    expect(c.tele?.hint).toMatch(/misma wifi/);
    expect(preflightExitCode(await runPreflight(deps({ tvReachable: async () => false })))).toBe(0);
  });

  it('--sin-red: ni Telegram ni la tele se tocan', async () => {
    const tg = vi.fn(async () => {});
    const tv = vi.fn(async () => true);
    const c = await byId(deps({ offline: true, checkTelegramToken: tg, tvReachable: tv }));
    expect(tg).not.toHaveBeenCalled();
    expect(tv).not.toHaveBeenCalled();
    expect(c.telegram?.status).toBe('info');
  });

  it('PC: modo servidor es info; fuera de Windows o apagado es aviso', async () => {
    expect((await byId(deps({ desktopEnabled: () => false }))).pc?.status).toBe('info');
    expect((await byId(deps({ platform: 'linux' }))).pc?.status).toBe('aviso');
    const off = await byId(deps({ computerUseEnabled: () => false }));
    expect(off.pc?.status).toBe('aviso');
    expect(off.pc?.hint).toMatch(/\/ordenador on/);
  });

  it('correo: sin configurar es info; a medias es aviso', async () => {
    expect(
      (await byId(deps({ mailStatus: async () => ({ read: 'falta', send: 'falta' }) }))).correo
        ?.status,
    ).toBe('info');
    expect(
      (await byId(deps({ mailStatus: async () => ({ read: 'ok', send: 'falta' }) }))).correo
        ?.status,
    ).toBe('aviso');
  });

  it('disco: <1 GB aviso, <200 MB fallo', async () => {
    expect((await byId(deps({ freeDiskBytes: async () => 0.5 * GB }))).disco?.status).toBe('aviso');
    expect((await byId(deps({ freeDiskBytes: async () => 100 * 1024 ** 2 }))).disco?.status).toBe(
      'fallo',
    );
    expect((await byId(deps({ freeDiskBytes: async () => null }))).disco?.status).toBe('info');
  });

  it('Node viejo: fallo', async () => {
    expect((await byId(deps({ nodeVersion: 'v20.11.0' }))).node?.status).toBe('fallo');
  });
});

describe('formatPreflight', () => {
  it('lista en español con iconos, arreglos y resumen; color solo si se pide', async () => {
    const checks = await runPreflight(
      deps({ tvReachable: async () => false }, { 'telegram:botToken': '' }),
    );
    const plain = formatPreflight(checks);
    expect(plain).toMatch(/^Asistenta — comprobación de arranque/);
    expect(plain).toContain('❌ Telegram');
    expect(plain).toContain('⚠️ Tele');
    expect(plain).toContain('→ pa vault set telegram:botToken');
    expect(plain).toContain('1 problema impide arrancar y hay 1 aviso.');
    expect(plain).not.toContain('\x1b[');
    expect(formatPreflight(checks, { color: true })).toContain('\x1b[31m');
  });
});

describe('pa iniciar', () => {
  const io = (d: PreflightDeps, serve = vi.fn(async () => 0)) => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      serve,
      io: {
        deps: async () => d,
        serve,
        write: (t: string) => out.push(t),
        writeErr: (t: string) => err.push(t),
        color: false,
      },
    };
  };

  it('todo bien: pinta la lista y arranca el daemon', async () => {
    const h = io(
      deps(),
      vi.fn(async () => 0),
    );
    expect(await iniciarCommand([], h.io)).toBe(0);
    expect(h.serve).toHaveBeenCalledTimes(1);
    expect(h.out.join('')).toContain('Arrancando Asistenta');
  });

  it('con un fallo no arranca y sale con 1', async () => {
    const h = io(deps({ vaultExists: () => false }));
    expect(await iniciarCommand([], h.io)).toBe(1);
    expect(h.serve).not.toHaveBeenCalled();
    expect(h.err.join('')).toMatch(/No arranco/);
  });

  it('--solo-comprobar no arranca; --json da la lista en JSON', async () => {
    const h = io(deps());
    expect(await iniciarCommand(['--solo-comprobar'], h.io)).toBe(0);
    expect(h.serve).not.toHaveBeenCalled();
    const j = io(deps({ tvReachable: async () => false }));
    expect(await iniciarCommand(['--json'], j.io)).toBe(0);
    const parsed = JSON.parse(j.out.join(''));
    expect(parsed.ok).toBe(true);
    expect(parsed.checks.find((c: { id: string }) => c.id === 'tele').status).toBe('aviso');
    expect(j.serve).not.toHaveBeenCalled();
  });

  it('opción desconocida: uso y código 2, sin comprobar nada', async () => {
    const d = vi.fn(async () => deps());
    const h = io(deps());
    expect(await iniciarCommand(['--borrar'], { ...h.io, deps: d })).toBe(2);
    expect(d).not.toHaveBeenCalled();
    expect(h.err.join('')).toMatch(/Uso: pa iniciar/);
    expect(parseIniciarArgs(['--sin-red', '--check'])).toEqual({
      checkOnly: true,
      json: false,
      offline: true,
    });
  });

  it('la CLI enruta `pa iniciar` y lo anuncia en la ayuda', async () => {
    const { readFileSync } = await import('node:fs');
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toMatch(/case 'iniciar':/);
    expect(cli).toMatch(/pa iniciar \[--solo-comprobar\]/);
  });
});
