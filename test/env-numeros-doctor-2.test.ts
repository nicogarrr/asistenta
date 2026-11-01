import { describe, expect, it } from 'vitest';
import { envNumbersDoctorLine } from '../src/env-flags.js';
import { pasteSettleMs } from '../src/screen/windows.js';

const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv;

describe('pa doctor: PA_WEBHOOK_PER_MINUTE y PA_COMPUTER_PASTE_SETTLE_MS mal escritos', () => {
  it('«20 por minuto» en PA_WEBHOOK_PER_MINUTE se avisa (antes quedaba en 10 sin decir nada)', () => {
    const line = envNumbersDoctorLine(env({ PA_WEBHOOK_PER_MINUTE: '20 por minuto' })) ?? '';
    expect(line).toContain('PA_WEBHOOK_PER_MINUTE «20 por minuto»');
    expect(line).toContain('p. ej. 10');
  });

  it('PA_WEBHOOK_PER_MINUTE=0 también se avisa: el webhook usa 10', () => {
    expect(envNumbersDoctorLine(env({ PA_WEBHOOK_PER_MINUTE: '0' }))).toContain(
      'PA_WEBHOOK_PER_MINUTE',
    );
  });

  it('«400 ms» en PA_COMPUTER_PASTE_SETTLE_MS se avisa', () => {
    const line = envNumbersDoctorLine(env({ PA_COMPUTER_PASTE_SETTLE_MS: '400 ms' })) ?? '';
    expect(line).toContain('PA_COMPUTER_PASTE_SETTLE_MS «400 ms»');
    expect(line).toContain('p. ej. 400');
  });

  it('valores bien escritos no avisan', () => {
    expect(
      envNumbersDoctorLine(
        env({ PA_WEBHOOK_PER_MINUTE: '20', PA_COMPUTER_PASTE_SETTLE_MS: '800' }),
      ),
    ).toBeUndefined();
  });

  it('Computer Use no cambia: el pegado sigue leyéndose igual', () => {
    expect(pasteSettleMs(env({ PA_COMPUTER_PASTE_SETTLE_MS: '400 ms' }))).toBe(400);
    expect(pasteSettleMs(env({ PA_COMPUTER_PASTE_SETTLE_MS: '800' }))).toBe(800);
    expect(pasteSettleMs(env({ PA_COMPUTER_PASTE_SETTLE_MS: '9000' }))).toBe(5000);
  });
});
