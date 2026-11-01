import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { successMessage } from '../src/autoupdate.js';
import {
  answerPendingNovedades,
  buildUpdateNotice,
  NOVEDADES_FILE,
  savePendingNovedades,
} from '../src/autoupdate-novedades.js';
import { BUSY_DIR } from '../src/ocupada.js';

/**
 * Nico (1 nov): tras actualizarse, el aviso decía «y 1 cambio más» y no había forma de
 * verlo (otra vez fueron «y 531 cambios más»). Ahora se ven todos: si caben, todos en
 * el aviso; si son muchísimos, los destacados y «¿Quieres verlos? Dime «sí»».
 */
const TELEGRAM_MAX = 4096;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-novedades-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const subjects = (n: number, prefix = 'feat') =>
  Array.from({ length: n }, (_, i) => `${prefix}: función nueva número ${i + 1} (#${1000 + i})`);

describe('aviso de actualización: se ven todos los cambios', () => {
  it('con un cambio de sobra lo enseña en vez de «y 1 cambio más»', () => {
    const text = successMessage(subjects(9));
    expect(text).not.toMatch(/cambios? más/);
    for (let i = 1; i <= 9; i++) expect(text).toContain(`• Función nueva número ${i}\n`.trim());
    expect(buildUpdateNotice(subjects(9)).rest).toEqual([]);
  });

  it('si quedan pocos (hasta 15 en total) los pone todos, nunca «y N más»', () => {
    const text = successMessage(subjects(15));
    expect(text.split('\n').filter((l) => l.startsWith('• '))).toHaveLength(15);
    expect(text).not.toMatch(/más\b/);
  });

  it('531 cambios: 10 destacados, la pregunta natural y el resto guardado', () => {
    const notice = buildUpdateNotice(subjects(531));
    const bullets = notice.text.split('\n').filter((l) => l.startsWith('• '));
    expect(bullets).toHaveLength(10);
    expect(notice.text).toContain(
      'Hay otros 521 cambios. ¿Quieres verlos? Dime «sí» y te los paso.',
    );
    expect(notice.text).not.toMatch(/[<>]/);
    expect(notice.text.length).toBeLessThanOrEqual(TELEGRAM_MAX);
    expect(notice.rest.length).toBe(521);
  });

  it('deja el tema del cambio («Dictado: …») y solo quita el tipo técnico', () => {
    const text = successMessage([
      'Dictado: Esc descarta lo grabado y modo alternar (#1574)',
      'tablero: «el finde que viene» (#1544)',
      'feat(tele): sube a tope (#712)',
    ]);
    expect(text).toBe(
      '🆕 Me he actualizado\n• Dictado: Esc descarta lo grabado y modo alternar\n• Tablero: «el finde que viene»\n• Sube a tope',
    );
  });

  it('lo de por dentro («orden interno», tests, refactor) va al final', () => {
    const mixed = [
      'refactor: orden interno (#1576)',
      'test: más pruebas del vigilante',
      'chore: biome',
      'Ordenar: botón de la tele e hilo de inspección salen de cli.ts (#1576)',
      ...subjects(20),
    ];
    const notice = buildUpdateNotice(mixed);
    expect(notice.text).not.toContain('Orden interno');
    expect(notice.text).not.toContain('cli.ts');
    expect(notice.rest.slice(-4).map((r) => r.text)).toEqual([
      'Orden interno',
      'Más pruebas del vigilante',
      'Biome',
      'Ordenar: botón de la tele e hilo de inspección salen de cli.ts',
    ]);
    const few = successMessage(['refactor: orden interno', 'feat: dictado con Esc']);
    expect(few).toBe('🆕 Me he actualizado\n• Dictado con Esc\n• Orden interno');
  });
});

describe('«sí» tras el aviso: manda el resto en trozos', () => {
  const now = Date.parse('2026-11-01T01:00:00Z');

  it('531 cambios: con «sí» llegan los 521 que faltan, cada mensaje ≤ 4096', () => {
    const notice = buildUpdateNotice(subjects(531));
    savePendingNovedades(dir, notice.rest, now);
    const parts = answerPendingNovedades(dir, 'Sí', now + 60_000);
    expect(parts).not.toBeNull();
    expect(parts?.length).toBeGreaterThan(1);
    for (const p of parts ?? []) expect(p.length).toBeLessThanOrEqual(TELEGRAM_MAX);
    const all = (parts ?? []).join('\n');
    expect(parts?.[0]).toMatch(/^Los otros 521 cambios:/);
    const shown = new Set(notice.text.split('\n').filter((l) => l.startsWith('• ')));
    for (let i = 1; i <= 531; i++) {
      const line = `• Función nueva número ${i}`;
      expect(shown.has(line) || all.split('\n').includes(line)).toBe(true);
    }
    // Una vez enviado, otro «sí» ya no es para esto.
    expect(answerPendingNovedades(dir, 'sí', now + 120_000)).toBeNull();
    expect(existsSync(join(dir, BUSY_DIR, NOVEDADES_FILE))).toBe(false);
  });

  it('lo de por dentro va en su propio apartado', () => {
    const notice = buildUpdateNotice([...subjects(30), 'refactor: orden interno']);
    savePendingNovedades(dir, notice.rest, now);
    const parts = answerPendingNovedades(dir, 'vale, pásamelos', now) ?? [];
    expect(parts.join('\n')).toMatch(/Por dentro \(no notarás nada distinto\):\n• Orden interno$/);
  });

  it('«no» lo descarta con una respuesta corta; otra cosa lo deja pasar al agente', () => {
    savePendingNovedades(dir, buildUpdateNotice(subjects(40)).rest, now);
    expect(answerPendingNovedades(dir, 'no, gracias', now)).toEqual(['Vale, sin problema.']);
    expect(answerPendingNovedades(dir, 'sí', now)).toBeNull();

    savePendingNovedades(dir, buildUpdateNotice(subjects(40)).rest, now);
    expect(answerPendingNovedades(dir, 'sí, y recuérdame mañana llamar al taller', now)).toBeNull();
    // Solo cuenta el mensaje siguiente al aviso.
    expect(answerPendingNovedades(dir, 'sí', now)).toBeNull();
  });

  it('pasado un día, un «sí» ya no es para el aviso', () => {
    savePendingNovedades(dir, buildUpdateNotice(subjects(40)).rest, now);
    expect(answerPendingNovedades(dir, 'sí', now + 25 * 3_600_000)).toBeNull();
  });

  it('sin nada pendiente no hace nada; un aviso sin resto borra lo viejo', () => {
    expect(answerPendingNovedades(dir, 'sí', now)).toBeNull();
    savePendingNovedades(dir, buildUpdateNotice(subjects(40)).rest, now);
    savePendingNovedades(dir, [], now);
    expect(answerPendingNovedades(dir, 'sí', now)).toBeNull();
  });
});
