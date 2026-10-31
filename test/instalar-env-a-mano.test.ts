import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error TS7016: módulo .mjs ejecutable, sin declaración de tipos.
import { envText, instalar, presetFromEnv } from '../scripts/instalar.mjs';

// Un .env tocado a mano (a medias, con mayúsculas o guardado por el Bloc de notas en
// UTF-16) se leía distinto en el instalador que en Asistenta: con el modelo local
// el instalador exigía igualmente la clave de pago y acababa con «Sin la clave del
// modelo Asistenta no puede contestar». Ahora lo lee con las mismas reglas.
describe('presetFromEnv lee el .env como Asistenta', () => {
  it('una línea vacía PA_PROVIDER_PRESET= no se come la línea siguiente', () => {
    expect(presetFromEnv('PA_PROVIDER_PRESET=\nPA_DESKTOP=off\n')).toBe('opencode');
    expect(presetFromEnv('PA_PROVIDER_PRESET=\nopencode-local\n')).toBe('opencode');
  });

  it('da igual mayúsculas y espacios', () => {
    expect(presetFromEnv('PA_PROVIDER_PRESET= OpenCode-Local \r\n')).toBe('opencode-local');
  });

  it('si la clave sale dos veces, gana la última (como al arrancar)', () => {
    expect(presetFromEnv('PA_PROVIDER_PRESET=opencode\nPA_PROVIDER_PRESET=opencode-local\n')).toBe(
      'opencode-local',
    );
  });

  it('la variable del sistema gana al .env (como al arrancar)', () => {
    expect(
      presetFromEnv('PA_PROVIDER_PRESET=opencode', { PA_PROVIDER_PRESET: 'opencode-local' }),
    ).toBe('opencode-local');
  });
});

describe('envText: .env guardado por el Bloc de notas', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const file = (buf: Buffer) => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-inst-env-'));
    dirs.push(dir);
    const p = join(dir, '.env');
    writeFileSync(p, buf);
    return p;
  };
  const txt = 'PA_PROVIDER_PRESET=opencode-local\r\n';

  it('UTF-16 (Unicode) y UTF-8 con BOM se leen bien', () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(txt, 'utf16le')]);
    expect(presetFromEnv(envText(file(le)))).toBe('opencode-local');
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(txt)]);
    expect(presetFromEnv(envText(file(bom)))).toBe('opencode-local');
  });

  it('sin .env devuelve texto vacío', () => {
    expect(envText(join(tmpdir(), 'no-existe-pa-inst', '.env'))).toBe('');
  });
});

describe('instalar con modelo local escrito a mano', () => {
  it('no pide la clave de pago', async () => {
    const out: string[] = [];
    const ask = vi.fn(async (q: string) => (q.includes('token') ? '' : q.includes('ID') ? '' : ''));
    const d = {
      nodeVersion: 'v24.3.0',
      cwd: 'C:\\Asistenta',
      env: {},
      write: (s: string) => out.push(s),
      run: vi.fn(async () => 0),
      exists: (p: string) => p === '.env',
      copy: vi.fn(),
      readEnv: () => 'PA_PROVIDER_PRESET=OpenCode-Local\r\n',
      cli: vi.fn(async () => 1),
      vaultList: async () => ['telegram:botToken', 'telegram:allowedUserIds'],
      vaultSet: vi.fn(async () => 0),
      ask,
      fetch: vi.fn(),
    };
    expect(await instalar(d)).toBe(0);
    expect(ask).not.toHaveBeenCalledWith(
      expect.stringContaining('clave del modelo'),
      expect.anything(),
    );
    expect(out.join('')).toContain('Modelo local');
  });
});
