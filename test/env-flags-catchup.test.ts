import { describe, expect, it } from 'vitest';
import { envSwitchesDoctorLine, envSwitchOn } from '../src/env-flags.js';

const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv;

describe('PA_ROUTINE_CATCHUP escrito como una persona', () => {
  it('está encendido por defecto y con 1, sí o true', () => {
    expect(envSwitchOn('PA_ROUTINE_CATCHUP', env({}))).toBe(true);
    for (const v of ['1', 'sí', 'true', '']) {
      expect(envSwitchOn('PA_ROUTINE_CATCHUP', env({ PA_ROUTINE_CATCHUP: v }))).toBe(true);
    }
  });

  it('se apaga con 0, no, false u off', () => {
    for (const v of ['0', 'no', 'No', 'false', 'off', 'apagado']) {
      expect(envSwitchOn('PA_ROUTINE_CATCHUP', env({ PA_ROUTINE_CATCHUP: v }))).toBe(false);
    }
  });

  it('un valor raro deja el por defecto y pa doctor lo dice', () => {
    expect(envSwitchOn('PA_ROUTINE_CATCHUP', env({ PA_ROUTINE_CATCHUP: 'nunca' }))).toBe(true);
    expect(envSwitchesDoctorLine(env({ PA_ROUTINE_CATCHUP: 'nunca' }))).toContain(
      'PA_ROUTINE_CATCHUP «nunca»',
    );
  });
});
