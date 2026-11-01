import { describe, expect, it } from 'vitest';
import { buildWeeklySummary } from '../src/weekly.js';

// Nico (31 oct): que Asistenta hable como en un chat. El resumen del domingo
// sin «builds», «rutas», «playbook» ni «clasificadas».
describe('resumen semanal sin jerga', () => {
  const text = buildWeeklySummary({
    entries: [
      {
        ts: new Date(1_800_000_000_000 - 1000).toISOString(),
        actor: 'asistenta',
        action: 'turn',
        result: 'ok',
      },
    ],
    now: 1_800_000_000_000,
    pending: '',
    watching: 0,
    playbooks: [{ domain: 'seg-social.es', ok: 2, failed: 1 }],
    barge: { sessions: 1, bargeIns: 4, trueIns: 3, falseNoise: 1, falseEcho: 0, unclassified: 2 },
  });

  it('no usa palabras técnicas', () => {
    for (const w of [
      'Builds',
      'rutas distintas',
      'playbook',
      'clasificad',
      'estimad',
      'registro',
    ]) {
      expect(text).not.toContain(w);
    }
  });

  it('dice lo mismo en llano', () => {
    expect(text).toContain('- Proyectos de varios archivos que te he hecho: 0.');
    expect(text).toContain('- Gestiones en webs que ya conozco (desde que empecé a contarlas):');
    expect(text).toContain('  - seg-social.es: 2 terminadas, 1 sin terminar.');
    expect(text).toContain('- Veces que me cortaste al hablar: 4 (calculo que un 25% sin querer).');
  });
});
