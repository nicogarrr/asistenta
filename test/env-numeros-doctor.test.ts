import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { envNumbersDoctorLine } from '../src/env-flags.js';

const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv;

describe('pa doctor: ajustes numéricos que no son un número', () => {
  it('«30 días» en PA_FILE_RETENTION_DAYS se avisa con un ejemplo', () => {
    const line = envNumbersDoctorLine(env({ PA_FILE_RETENTION_DAYS: '30 días' }));
    expect(line).toContain('PA_FILE_RETENTION_DAYS «30 días»');
    expect(line).toContain('pon solo un número, p. ej. 30');
  });

  it('avisa de varios a la vez y solo de los que fallan', () => {
    const line =
      envNumbersDoctorLine(
        env({
          PA_LOG_DAY_MAX_MB: '20 MB',
          PA_DOCUMENT_RETENTION_DAYS: '90',
          PA_COMPACT_TOKENS: 'muchos',
        }),
      ) ?? '';
    expect(line).toContain('PA_LOG_DAY_MAX_MB «20 MB»');
    expect(line).toContain('PA_COMPACT_TOKENS «muchos»');
    expect(line).not.toContain('PA_DOCUMENT_RETENTION_DAYS');
  });

  it('lo vacío y los números bien escritos no generan aviso', () => {
    expect(envNumbersDoctorLine(env({}))).toBeUndefined();
    expect(
      envNumbersDoctorLine(
        env({
          PA_FILE_RETENTION_DAYS: '30',
          PA_DOCUMENT_RETENTION_DAYS: '',
          PA_LOG_DAY_MAX_MB: '1.5',
          PA_COMPACT_TOKENS: '100.000',
        }),
      ),
    ).toBeUndefined();
  });

  it('pa doctor enseña esa línea', () => {
    expect(readFileSync('src/cli.ts', 'utf8')).toContain('envNumbersDoctorLine()');
  });
});
