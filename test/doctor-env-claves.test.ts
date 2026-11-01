import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closestEnvKey,
  envUnknownKeysDoctorLine,
  knownEnvKeys,
  unknownEnvKeys,
} from '../src/doctor-env-keys.js';

const dirs: string[] = [];
const file = (name: string, text: string) => {
  const d = mkdtempSync(join(tmpdir(), 'pa-env-keys-'));
  dirs.push(d);
  const f = join(d, name);
  writeFileSync(f, text);
  return f;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const EXAMPLE = '# PA_WEB_PORT=8787   # panel\n# PA_WEB_TOKEN=\nPA_TIMEZONE=Europe/Madrid\n';

describe('pa doctor: claves del .env que Asistenta no conoce', () => {
  it('una errata en el nombre se avisa con el nombre bueno', () => {
    const line =
      envUnknownKeysDoctorLine(
        [file('.env', 'PA_WEB_PROT=8787\nPA_WEB_TOKEN=abc\n# PA_COMENTADA=1\n')],
        file('.env.example', EXAMPLE),
      ) ?? '';
    expect(line).toContain('no conozco PA_WEB_PROT (¿querías decir PA_WEB_PORT?)');
    expect(line).not.toContain('PA_WEB_TOKEN');
    expect(line).not.toContain('PA_COMENTADA');
    expect(line).not.toContain('8787');
  });

  it('claves conocidas, minúsculas sin PA_ o prefijos dinámicos no avisan', () => {
    const known = knownEnvKeys(EXAMPLE);
    const env = 'PA_TIMEZONE=Europe/Madrid\nexport PA_WEB_PORT=1\nPA_SECRET_GITHUB=x\nOTRA=1\n';
    expect(unknownEnvKeys(env, known)).toEqual([]);
  });

  it('sin parecido no inventa sugerencia', () => {
    expect(closestEnvKey('PA_ALGO_MUY_DISTINTO', knownEnvKeys(EXAMPLE))).toBeUndefined();
    expect(closestEnvKey('PA_TIMEZONA', knownEnvKeys(EXAMPLE))).toBe('PA_TIMEZONE');
  });

  it('sin .env.example (instalación rara) no dice nada', () => {
    expect(
      envUnknownKeysDoctorLine(
        [file('.env', 'PA_WEB_PROT=1\n')],
        join(tmpdir(), 'no-hay', '.env.example'),
      ),
    ).toBeUndefined();
  });

  it('el .env.example real conoce todo lo que trae (un .env recién instalado no avisa)', () => {
    const example = join(import.meta.dirname, '..', '.env.example');
    const text = readFileSync(example, 'utf8').replace(/^# (PA_)/gm, '$1');
    expect(envUnknownKeysDoctorLine([file('.env', text)], example)).toBeUndefined();
  });

  it('pa doctor la muestra', () => {
    const cli = readFileSync(join(import.meta.dirname, '..', 'src', 'cli.ts'), 'utf8');
    expect(cli).toMatch(/envUnknownKeysDoctorLine\(\)/);
  });
});
