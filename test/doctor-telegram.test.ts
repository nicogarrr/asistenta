/**
 * Primer uso en Windows: `pa doctor` no decía nada de Telegram. Sin token del bot
 * o sin el ID del dueño Asistenta no arranca, y el doctor salía limpio.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allowedTelegramIds, telegramDoctorLines } from '../src/doctor-telegram.js';

const TOKEN = `123456789:${'A'.repeat(35)}`;
const vault = (v: Record<string, string>) => async (k: string) => v[k];

describe('pa doctor: Telegram', () => {
  it('todo guardado: lo dice sin enseñar el token', async () => {
    const lines = await telegramDoctorLines(
      vault({ 'telegram:botToken': TOKEN, 'telegram:allowedUserIds': '111, 222' }),
    );
    expect(lines).toEqual([
      'telegram        token del bot guardado',
      'dueño           2 personas autorizadas',
    ]);
    expect(lines.join('\n')).not.toContain('AAAA');
    expect(
      await telegramDoctorLines(
        vault({ 'telegram:botToken': TOKEN, 'telegram:allowedUserIds': '111' }),
      ),
    ).toContain('dueño           1 persona autorizada');
  });

  it('falta el token o el ID: dice qué hacer, como el daemon al arrancar', async () => {
    const lines = await telegramDoctorLines(vault({}));
    expect(lines[0]).toMatch(/^telegram {8}FALTA el token del bot: doble clic en instalar\.bat/);
    expect(lines[0]).toContain('pa vault set-stdin telegram:botToken');
    expect(lines[1]).toMatch(/^dueño {11}FALTA tu ID de Telegram/);
    expect(lines[1]).toContain('escribe «hola» a tu bot');
  });

  it('un token mal pegado o un ID que no es número se nota', async () => {
    const lines = await telegramDoctorLines(
      vault({ 'telegram:botToken': 'mi token', 'telegram:allowedUserIds': '@nico' }),
    );
    expect(lines[0]).toContain('no parece de un bot');
    expect(lines[0]).not.toContain('mi token');
    expect(lines[1]).toContain('no es un número de Telegram');
    expect(allowedTelegramIds('12, x, -3, 4.5, 99')).toEqual([12, 99]);
  });

  it('si la caja fuerte no se puede leer, una línea clara y sin error técnico', async () => {
    const lines = await telegramDoctorLines(async () => {
      throw new Error('DPAPI: CryptUnprotectData failed');
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^telegram {8}no pude leer la caja fuerte/);
    expect(lines[0]).not.toContain('DPAPI');
  });

  it('pa doctor las incluye', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');
    expect(src).toContain(
      'if (vaultExists()) lines.push(...(await telegramDoctorLines(vaultGet, doctorFetch())));',
    );
  });

  it.skipIf(process.platform !== 'linux')('el doctor compilado avisa de lo que falta', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-doctor-tg-'));
    try {
      const env = {
        ...process.env,
        PA_STATE_DIR: dir,
        PA_DESKTOP: 'off',
        PA_VAULT_BACKEND: 'portable',
        NO_COLOR: '1',
        FORCE_COLOR: '',
      };
      const r = spawnSync(process.execPath, [resolve('dist/cli.js'), 'doctor'], {
        encoding: 'utf8',
        timeout: 60_000,
        env,
      });
      expect(r.status).toBe(0);
      if (r.stdout.includes('creado')) {
        expect(r.stdout).toMatch(/^telegram +FALTA el token del bot/m);
        expect(r.stdout).toMatch(/^dueño +FALTA tu ID de Telegram/m);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
