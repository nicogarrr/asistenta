import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { envLineProblems, envLinesDoctorLine } from '../src/doctor-env-lines.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('pa doctor: líneas del .env que no se leen como parecen', () => {
  it('así lo lee Node (por eso hace falta el aviso)', () => {
    expect(parseEnv('PA_WEB_PORT: 8787')).toEqual({});
    expect(parseEnv('PA_MODEL=a\nPA_MODEL=b').PA_MODEL).toBe('b');
    expect(parseEnv('PA_WEB_TOKEN=“abc”').PA_WEB_TOKEN).toBe('“abc”');
  });

  it('sin «=», repetida, comillas de móvil y comilla sin cerrar', () => {
    const text = [
      'PA_WEB_PORT: 8787',
      'PA_LANG es',
      'PA_MODEL=uno',
      '# PA_MODEL=comentada',
      'PA_MODEL=dos',
      'PA_WEB_TOKEN=“abcdef”',
      'PA_TIMEZONE="Europe/Madrid',
      'PA_BIEN="con comillas"',
      'PA_OTRO = 1',
      '',
    ].join('\r\n');
    expect(envLineProblems(text)).toEqual([
      'PA_WEB_PORT (falta el «=»: escribe PA_WEB_PORT=valor)',
      'PA_LANG (falta el «=»: escribe PA_LANG=valor)',
      'PA_WEB_TOKEN (comillas de móvil o Word: usa comillas rectas ")',
      'PA_TIMEZONE (falta cerrar la comilla)',
      'PA_MODEL (está 2 veces; vale la última)',
    ]);
  });

  it('la línea de pa doctor nunca enseña el valor', () => {
    const d = mkdtempSync(join(tmpdir(), 'pa-env-lines-'));
    dirs.push(d);
    const f = join(d, '.env');
    writeFileSync(f, 'PA_WEB_TOKEN=“SECRETO123”\nPA_WEB_PORT 8787\n');
    const line = envLinesDoctorLine([f]) ?? '';
    expect(line).toContain('PA_WEB_TOKEN (comillas de móvil o Word');
    expect(line).toContain('PA_WEB_PORT (falta el «=»');
    expect(line).not.toContain('SECRETO123');
    expect(line).not.toContain('8787');
  });

  it('un .env normal no avisa', () => {
    expect(envLineProblems('# hola\nPA_A=1\nexport PA_B="x y"\nPA_C=\n')).toEqual([]);
    expect(envLinesDoctorLine([join(tmpdir(), 'no-existe-pa', '.env')])).toBeUndefined();
  });

  it('un .env recién copiado de .env.example no avisa', () => {
    const example = readFileSync(join(import.meta.dirname, '..', '.env.example'), 'utf8');
    expect(envLineProblems(example)).toEqual([]);
  });

  it('pa doctor la muestra', () => {
    const cli = readFileSync(join(import.meta.dirname, '..', 'src', 'cli.ts'), 'utf8');
    expect(cli).toMatch(/envLinesDoctorLine\(\)/);
  });
});
