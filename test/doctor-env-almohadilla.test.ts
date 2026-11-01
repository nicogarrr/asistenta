import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { envHashCutKeys, envHashDoctorLine } from '../src/doctor-env-hash.js';

const dirs: string[] = [];
const envFile = (text: string) => {
  const d = mkdtempSync(join(tmpdir(), 'pa-env-hash-'));
  dirs.push(d);
  const f = join(d, '.env');
  writeFileSync(f, text);
  return f;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('pa doctor: un «#» sin comillas corta el valor del .env', () => {
  it('así lo lee Node: el token se queda a medias', () => {
    expect(parseEnv('PA_TELEGRAM_TOKEN=123:ab#cd').PA_TELEGRAM_TOKEN).toBe('123:ab');
  });

  it('detecta «#» pegado al valor y al principio del valor', () => {
    const text = [
      'PA_TELEGRAM_TOKEN=123:ab#cd',
      'export PA_WEB_TOKEN=#secreto',
      'PA_MODEL=deepseek # comentario normal',
      'PA_MAIL_PASSWORD="con#comillas"',
      "PA_OTRA='x#y'",
      '# PA_COMENTADA=a#b',
      'PA_VACIA= # nada',
    ].join('\n');
    expect(envHashCutKeys(text)).toEqual(['PA_TELEGRAM_TOKEN', 'PA_WEB_TOKEN']);
  });

  it('la línea de pa doctor nombra la clave y nunca enseña el valor', () => {
    const f = envFile('\uFEFFPA_TELEGRAM_TOKEN=123456:SECRETO#resto\r\nPA_LANG=es\r\n');
    const line = envHashDoctorLine([f]) ?? '';
    expect(line).toContain('PA_TELEGRAM_TOKEN lleva un «#» sin comillas');
    expect(line).toContain('PA_TELEGRAM_TOKEN="…"');
    expect(line).not.toContain('SECRETO');
    expect(line).not.toContain('123456');
    expect(line).not.toContain('resto');
  });

  it('sin «#» problemáticos, o sin .env, no hay aviso', () => {
    expect(envHashDoctorLine([envFile('PA_X=1 # uno\nPA_Y="a#b"\n')])).toBeUndefined();
    expect(envHashDoctorLine([join(tmpdir(), 'no-existe-pa', '.env')])).toBeUndefined();
  });

  it('pa doctor la muestra', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toMatch(/envHashDoctorLine\(\)/);
  });
});
