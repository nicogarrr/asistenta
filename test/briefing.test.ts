import { describe, expect, it } from 'vitest';
import { briefingDue, buildBriefing, MAX_BRIEFING_CHARS } from '../src/briefing.js';

/** Domingo 25 de octubre de 2026, hora local (la suite fija TZ=Europe/Madrid). */
const TODAY = new Date(2026, 9, 25, 9, 0, 0, 0);

function at(day: number, hour: number, minute = 0): Date {
  return new Date(2026, 9, day, hour, minute, 0, 0);
}

function input(overrides: Partial<Parameters<typeof buildBriefing>[0]> = {}) {
  return {
    greeting: 'Buenos días',
    today: TODAY,
    routines: [],
    followups: [],
    reminders: [],
    agenda: [],
    ...overrides,
  };
}

describe('buildBriefing', () => {
  it('compone las cuatro secciones en orden y con el contenido de cada fuente', () => {
    const text = buildBriefing(
      input({
        agenda: [{ title: 'Reunión con Ana', when: '09:30' }],
        routines: [{ name: 'Revisar el correo', nextRun: '10:00' }],
        reminders: [{ text: 'Regar las plantas', at: '18:00' }],
        followups: [{ subject: 'Responder a Juan', due: 'hoy' }],
      }),
    );

    expect(text.startsWith('Buenos días\n')).toBe(true);
    expect(text).toContain('\nHoy\n- 09:30: Reunión con Ana');
    expect(text).toContain('\nPendiente\n- Revisar el correo (10:00)');
    expect(text).toContain('\nRecordatorios\n- Regar las plantas (18:00)');
    expect(text).toContain('\nSeguimientos\n- Responder a Juan (hoy)');

    const headings = ['Hoy', 'Pendiente', 'Recordatorios', 'Seguimientos'];
    const found = text.split('\n').filter((line) => headings.includes(line));
    expect(found).toEqual(headings);
  });

  it('omite las secciones vacías sin dejar huecos', () => {
    const text = buildBriefing(
      input({
        followups: [{ subject: 'Llamar al gestor' }],
      }),
    );

    expect(text).toContain('Seguimientos');
    expect(text).toContain('- Llamar al gestor');
    expect(text).not.toContain('Hoy\n');
    expect(text).not.toContain('Pendiente');
    expect(text).not.toContain('Recordatorios');
    expect(text).not.toContain('\n\n\n');
  });

  it('sin nada apuntado lo dice en una línea, sin inventar agenda', () => {
    const text = buildBriefing(input());
    expect(text).toBe('Buenos días\n\nHoy, domingo 25/10, no tienes nada apuntado.');
  });

  it('normaliza espacios y descarta entradas vacías', () => {
    const text = buildBriefing(
      input({
        agenda: [{ title: '  Reunión\n  larga  ', when: ' 9:00 ' }],
        routines: [{ name: '   ' }],
        reminders: [{ text: 'Llamar\n a mamá' }],
      }),
    );

    expect(text).toContain('- 9:00: Reunión larga');
    expect(text).toContain('- Llamar a mamá');
    expect(text).not.toContain('Pendiente');
  });

  it('nunca supera el tope y recorta con puntos suspensivos', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({
      title: `Tarea ${i} con un título razonablemente largo para llenar el mensaje`,
      when: '10:00',
    }));
    const text = buildBriefing(input({ agenda: many }));

    expect(text.length).toBeLessThanOrEqual(MAX_BRIEFING_CHARS);
    expect(text.endsWith('…')).toBe(true);
    expect(text).toContain('Buenos días');
  });
});

describe('briefingDue', () => {
  it('no se envía antes de la hora configurada', () => {
    expect(briefingDue(undefined, at(25, 7, 59))).toBe(false);
    expect(briefingDue(at(24, 9).getTime(), at(25, 6))).toBe(false);
  });

  it('se envía al llegar la hora si no se ha enviado hoy', () => {
    expect(briefingDue(undefined, at(25, 8))).toBe(true);
    expect(briefingDue(at(24, 9).getTime(), at(25, 8))).toBe(true);
  });

  it('una vez al día: no repite si ya se envió hoy, ni aunque fuera antes de la hora', () => {
    expect(briefingDue(at(25, 8).getTime(), at(25, 9))).toBe(false);
    expect(briefingDue(at(25, 7).getTime(), at(25, 9))).toBe(false);
  });

  it('recupera el briefing perdido en el primer chequeo posterior', () => {
    expect(briefingDue(at(24, 9).getTime(), at(25, 23))).toBe(true);
    expect(briefingDue(at(23, 9).getTime(), at(25, 9))).toBe(true);
  });

  it('acepta otra hora y no repite con un adelanto de reloj dentro de hoy', () => {
    expect(briefingDue(undefined, at(25, 9), 10)).toBe(false);
    expect(briefingDue(undefined, at(25, 10), 10)).toBe(true);
    // Envío registrado hoy a las 09:30 con el reloj adelantado; ahora son las 09:00.
    expect(briefingDue(at(25, 9, 30).getTime(), at(25, 9))).toBe(false);
    expect(briefingDue(undefined, new Date(Number.NaN))).toBe(false);
  });

  it('un último envío en un día futuro (reloj corregido) no bloquea el briefing', () => {
    // Antes: false hasta que pasara el día 26 (y ese día tampoco, por ser "el mismo día").
    expect(briefingDue(at(26, 9).getTime(), at(25, 9))).toBe(true);
    expect(briefingDue(new Date(2027, 0, 1, 9).getTime(), at(25, 9))).toBe(true);
    // Sigue respetando la hora.
    expect(briefingDue(at(26, 9).getTime(), at(25, 7))).toBe(false);
  });
});
