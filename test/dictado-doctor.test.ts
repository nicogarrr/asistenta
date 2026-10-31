import { describe, expect, it } from 'vitest';
import { dictadoDoctorLine } from '../src/dictado/doctor.js';
import { doctorLineEs } from '../src/doctor-labels.js';

describe('pa doctor: línea del dictado', () => {
  const on = { PA_DICTADO: '1' };
  it('dice en una línea si está listo y, si no, qué falta', () => {
    expect(dictadoDoctorLine({}, 'win32')).toMatch(/^dictado +apagado \(PA_DICTADO=1/);
    expect(dictadoDoctorLine(on, 'linux')).toMatch(/solo funciona en Windows$/);
    expect(dictadoDoctorLine(on, 'win32', false)).toMatch(/PA_DESKTOP=off/);
    expect(dictadoDoctorLine({ ...on, PA_DICTADO_TECLA: 'ctrl+q' }, 'win32')).toMatch(
      /no entiendo PA_DICTADO_TECLA «ctrl\+q»/,
    );
    expect(dictadoDoctorLine({ ...on, PA_DICTADO_TECLA: 'ctrl+alt' }, 'win32')).toMatch(
      /listo: mantén ctrl\+alt, habla y suelta/,
    );
  });

  it('sale tal cual en castellano', () => {
    const l = dictadoDoctorLine(on, 'win32');
    expect(doctorLineEs(l)).toBe(l);
  });
});
