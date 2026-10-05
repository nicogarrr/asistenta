import { afterEach, describe, expect, it } from 'vitest';
import { applyConfiguredTimeZone } from '../src/datecontext.js';

const original = process.env.TZ;
const originalPa = process.env.PA_TIMEZONE;
afterEach(() => {
  if (originalPa === undefined) delete process.env.PA_TIMEZONE;
  else process.env.PA_TIMEZONE = originalPa;
  if (original === undefined) delete process.env.TZ;
  else process.env.TZ = original;
});

describe('applyConfiguredTimeZone', () => {
  it('pone el reloj del proceso en la zona de PA_TIMEZONE (Date y croner la leen de ahí)', () => {
    const at = new Date('2026-10-05T12:00:00Z');
    process.env.TZ = 'UTC';
    expect(at.getHours()).toBe(12);
    process.env.PA_TIMEZONE = 'Asia/Tokyo';
    expect(applyConfiguredTimeZone()).toBe('Asia/Tokyo');
    expect(at.getHours()).toBe(21);
  });

  it('sin PA_TIMEZONE o con una zona inválida no toca nada', () => {
    const env: NodeJS.ProcessEnv = { TZ: 'UTC' };
    expect(applyConfiguredTimeZone(env)).toBeNull();
    expect(applyConfiguredTimeZone({ ...env, PA_TIMEZONE: 'No/Existe' })).toBeNull();
    expect(env.TZ).toBe('UTC');
  });
});
