import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
// Instalador en Node ESM puro: corre antes de `npm ci`, fuera del build.
// @ts-expect-error TS7016: módulo .mjs ejecutable, sin declaración de tipos.
import { instalar, nodeMajor, presetFromEnv, waitOwnerMessage } from '../scripts/instalar.mjs';

const TOKEN = `123456789:${'A'.repeat(35)}`;
const KEY = 'sk-clave-secreta-modelo-123';

type Res = { status: number; ok: boolean; json: () => Promise<unknown> };
const res = (status: number, body: unknown = {}): Res => ({
  status,
  ok: status < 300,
  json: async () => body,
});
const ownerMsg = (id = 42) => ({
  result: [
    {
      update_id: 7,
      message: { chat: { type: 'private' }, from: { id, first_name: 'Nico', username: 'nico' } },
    },
  ],
});

function deps(over: Record<string, unknown> = {}) {
  const out: string[] = [];
  const answers = [...((over.answers as string[]) ?? [TOKEN, KEY, 's'])];
  const vault = new Map<string, string>();
  let init = false;
  const d = {
    nodeVersion: 'v24.3.0',
    write: (s: string) => out.push(s),
    run: vi.fn(async () => 0),
    exists: (p: string): boolean => p === '.env.example',
    copy: vi.fn(),
    readEnv: () => 'PA_PROVIDER_PRESET=opencode\n',
    cli: vi.fn(async () => {
      init = true;
      return 0;
    }),
    vaultList: async () => (init ? [...vault.keys()] : null),
    vaultSet: vi.fn(async (k: string, v: string) => {
      vault.set(k, v);
      return 0;
    }),
    ask: vi.fn(async () => answers.shift() ?? ''),
    fetch: vi.fn(async (url: string) =>
      url.includes('offset=') ? res(200, { result: [] }) : res(200, ownerMsg()),
    ),
    ...over,
  };
  return { d, out, vault, text: () => out.join('') };
}

describe('instalar.mjs: instalación en un paso', () => {
  it('con todo bien: instala, compila, crea .env y guarda las tres piezas sin enseñarlas', async () => {
    const { d, vault, text } = deps();
    expect(await instalar(d)).toBe(0);
    expect(d.run).toHaveBeenNthCalledWith(1, 'npm', ['ci', '--no-audit', '--no-fund']);
    expect(d.run).toHaveBeenNthCalledWith(2, 'npm', ['run', 'build']);
    expect(d.copy).toHaveBeenCalledWith('.env.example', '.env');
    expect(d.cli).toHaveBeenCalledWith(['vault', 'init']);
    expect(Object.fromEntries(vault)).toEqual({
      'telegram:botToken': TOKEN,
      'provider:apiKey': KEY,
      'telegram:allowedUserIds': '42',
    });
    expect(text()).not.toContain(TOKEN);
    expect(text()).not.toContain(KEY);
    expect(text()).toContain('levantar.bat');
    // El «hola» de prueba queda leído: Asistenta no lo contesta luego.
    expect(d.fetch.mock.calls.some(([u]) => String(u).includes('offset=8'))).toBe(true);
  });

  it('Node viejo: para antes de tocar nada y dice dónde bajarlo', async () => {
    const { d, text } = deps({ nodeVersion: 'v20.11.0' });
    expect(await instalar(d)).toBe(1);
    expect(d.run).not.toHaveBeenCalled();
    expect(text()).toMatch(/Node 24.*nodejs\.org/);
  });

  it('npm ci falla: mensaje claro y no compila', async () => {
    const { d, text } = deps({ run: vi.fn(async () => 1) });
    expect(await instalar(d)).toBe(1);
    expect(d.run).toHaveBeenCalledTimes(1);
    expect(text()).toContain('No se han podido instalar las dependencias');
  });

  it('token mal pegado tres veces: no guarda nada y explica qué falta', async () => {
    const { d, vault, text } = deps({ answers: ['hola', 'abc', '123'] });
    expect(await instalar(d)).toBe(1);
    expect(vault.size).toBe(0);
    expect(text()).toContain('Sin el token de Telegram');
  });

  it('Telegram rechaza el token: lo dice en castellano', async () => {
    const { d, text } = deps({ fetch: vi.fn(async () => res(401)) });
    expect(await instalar(d)).toBe(1);
    expect(text()).toContain('ese token no vale');
  });

  it('si no es el dueño, pide el ID a mano', async () => {
    const { d, vault } = deps({ answers: [TOKEN, KEY, 'n', 'x1', '555666'] });
    expect(await instalar(d)).toBe(0);
    expect(vault.get('telegram:allowedUserIds')).toBe('555666');
  });

  it('modelo local: no pide clave; sin clave en la nube, para', async () => {
    const local = deps({
      readEnv: () => 'PA_PROVIDER_PRESET=opencode-local',
      answers: [TOKEN, 's'],
    });
    expect(await instalar(local.d)).toBe(0);
    expect(local.vault.has('provider:apiKey')).toBe(false);
    const sin = deps({ answers: [TOKEN, ''] });
    expect(await instalar(sin.d)).toBe(1);
    expect(sin.text()).toContain('Sin la clave del modelo');
  });

  it('reinstalar con todo guardado: Enter mantiene las claves y no espera a Telegram', async () => {
    const { d, vault } = deps({ answers: ['', ''] });
    d.exists = () => true;
    vault
      .set('telegram:botToken', TOKEN)
      .set('provider:apiKey', KEY)
      .set('telegram:allowedUserIds', '42');
    d.vaultList = async () => [...vault.keys()];
    expect(await instalar(d)).toBe(0);
    expect(d.vaultSet).not.toHaveBeenCalled();
    expect(d.fetch).not.toHaveBeenCalled();
    expect(d.copy).not.toHaveBeenCalled();
  });

  it('ayudantes', async () => {
    expect(nodeMajor('v24.1.0')).toBe(24);
    expect(nodeMajor('raro')).toBe(0);
    expect(presetFromEnv('# x\nPA_PROVIDER_PRESET="openrouter"')).toBe('openrouter');
    expect(presetFromEnv('')).toBe('opencode');
    const busy = await waitOwnerMessage(async () => res(409), TOKEN);
    expect(busy).toEqual({ error: 'ocupado' });
    const quiet = await waitOwnerMessage(async () => res(200, { result: [] }), TOKEN, { tries: 2 });
    expect(quiet).toEqual({ error: 'tiempo' });
  });

  it('los .bat llevan al instalador', () => {
    expect(readFileSync('instalar.bat', 'utf8')).toContain('scripts\\instalar.mjs');
    expect(readFileSync('levantar.bat', 'utf8')).toContain('instalar.bat');
  });
});
