import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error TS7016: módulo .mjs ejecutable, sin declaración de tipos.
import { conValor, instalar, paraInstalado } from '../scripts/instalar.mjs';
// @ts-expect-error TS7016: módulo .mjs ejecutable, sin declaración de tipos.
import { configurarDeps } from '../scripts/windows-app/configurar.mjs';
import { missingPieceMessage } from '../src/setup-missing.js';

// Primer arranque de alguien que instala el .exe: «Configurar Asistenta» le pide lo
// necesario sin abrir el .env, y los mensajes no le mandan a un instalar.bat que no tiene.
const TOKEN = `123456789:${'A'.repeat(35)}`;

function deps(answers: string[], over: Record<string, unknown> = {}) {
  const out: string[] = [];
  const env: Record<string, string> = {};
  const vault = new Map<string, string>();
  const d = {
    nodeVersion: 'v24.3.0',
    cwd: 'C:\\Users\\ana\\AppData\\Local\\Asistenta\\app',
    env: {},
    write: (s: string) => out.push(s),
    run: vi.fn(async () => 0),
    exists: (f: string) => f === '.env.example',
    copy: vi.fn(),
    readEnv: () =>
      Object.entries(env)
        .map(([k, v]) => `${k}=${v}\n`)
        .join(''),
    setEnv: vi.fn((k: string, v: string) => {
      env[k] = v;
    }),
    cli: vi.fn(async () => 0),
    vaultList: async () => [...vault.keys()],
    vaultSet: vi.fn(async (k: string, v: string) => {
      vault.set(k, v);
      return 0;
    }),
    vaultGet: async (k: string) => vault.get(k) ?? '',
    ask: vi.fn(async () => answers.shift() ?? ''),
    fetch: vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        result: [
          {
            update_id: 1,
            message: { from: { id: 4242, first_name: 'Ana' }, chat: { type: 'private' } },
          },
        ],
      }),
    })),
    ...over,
  };
  return { d, env, vault, text: () => out.join('') };
}

describe('primer arranque desde el instalador .exe', () => {
  it('pide token, clave, te reconoce y tu nombre; lo guarda sin tocar el .env a mano', async () => {
    const { d, env, vault, text } = deps([TOKEN, 'clave-del-modelo', 's', 'Ana García']);
    expect(await instalar(configurarDeps(d, d.cwd))).toBe(0);
    expect(vault.get('telegram:botToken')).toBe(TOKEN);
    expect(vault.get('provider:apiKey')).toBe('clave-del-modelo');
    expect(vault.get('telegram:allowedUserIds')).toBe('4242');
    expect(env.PA_OWNER_NAME).toBe('Ana García');
    expect(text()).toContain('✓ Encantada, Ana García');
    // Los secretos nunca salen en pantalla.
    expect(text()).not.toContain(TOKEN);
    expect(text()).not.toContain('clave-del-modelo');
    // Ni levantar.bat ni instalar.bat: esa copia no los trae.
    expect(text()).not.toMatch(/levantar\.bat|instalar\.bat|autostart install/);
  });

  it('si falta algo, le dice que vuelva a abrir «Configurar Asistenta», no instalar.bat', async () => {
    const { d, text } = deps(['', '', '']);
    expect(await instalar(configurarDeps(d, d.cwd))).toBe(1);
    expect(text()).toContain('Vuelve a abrir «Configurar Asistenta» (menú Inicio)');
    expect(text()).not.toContain('instalar.bat');
  });

  it('con el nombre ya puesto no lo vuelve a preguntar; Enter lo salta', async () => {
    const a = deps([TOKEN, 'k', 's']);
    a.d.readEnv = () => 'PA_OWNER_NAME=Luis\n';
    expect(await instalar(a.d)).toBe(0);
    expect(a.d.ask).not.toHaveBeenCalledWith(expect.stringContaining('¿Cómo te llamas?'));
    expect(a.d.setEnv).not.toHaveBeenCalled();
    const b = deps([TOKEN, 'k', 's', '']);
    expect(await instalar(b.d)).toBe(0);
    expect(b.d.setEnv).not.toHaveBeenCalled();
  });
});

describe('conValor: escribe una opción del .env por ti', () => {
  it('cambia la línea activa, la de ejemplo comentada, o la añade', () => {
    expect(conValor('A=1\nPA_OWNER_NAME=Old\n', 'PA_OWNER_NAME', 'Nico')).toBe(
      'A=1\nPA_OWNER_NAME=Nico\n',
    );
    expect(conValor('# PA_OWNER_NAME=Nico\nB=2\n', 'PA_OWNER_NAME', 'Ana')).toBe(
      'PA_OWNER_NAME=Ana\nB=2\n',
    );
    expect(conValor('B=2\n', 'PA_OWNER_NAME', 'Ana')).toBe('B=2\nPA_OWNER_NAME=Ana\n');
    expect(conValor('', 'PA_OWNER_NAME', 'Ana')).toBe('PA_OWNER_NAME=Ana\n');
  });

  it('con espacios va entre comillas y nunca rompe en dos líneas', () => {
    const t = conValor('X=1\n', 'PA_OWNER_NAME', 'Ana "la" García\nPA_DESKTOP=on');
    expect(t).toBe('X=1\nPA_OWNER_NAME="Ana  la  García PA_DESKTOP=on"\n');
    expect(t).not.toMatch(/^PA_DESKTOP=/m);
  });
});

describe('mensajes de arranque en la copia instalada', () => {
  it('mandan al menú Inicio, no a instalar.bat ni a pa vault', () => {
    for (const p of ['vault', 'token', 'owner'] as const) {
      const m = missingPieceMessage(p, { instalado: true });
      expect(m).toContain('«Configurar Asistenta»');
      expect(m).not.toMatch(/instalar\.bat|pa vault/);
    }
    expect(missingPieceMessage('token', { instalado: false })).toContain('instalar.bat');
  });

  it('paraInstalado cambia cada forma de «abrir instalar.bat»', () => {
    expect(paraInstalado('Vuelve a abrir instalar.bat.')).toBe(
      'Vuelve a abrir «Configurar Asistenta» (menú Inicio).',
    );
    expect(paraInstalado('o volver a abrir instalar.bat luego')).not.toContain('instalar.bat');
    expect(paraInstalado('Abre instalar.bat con tu usuario normal')).not.toContain('instalar.bat');
  });
});
