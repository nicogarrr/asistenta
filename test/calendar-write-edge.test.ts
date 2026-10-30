import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent } from '../src/agenda/write.js';

const START = new Date('2026-11-02T17:00:00Z');
let dir = '';
let file = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-ics-'));
  file = join(dir, 'calendar', 'local.ics');
  mkdirSync(join(dir, 'calendar'), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const lines = (text: string): string[] => text.split('\r\n').filter((l) => l !== '');
const count = (text: string, needle: string): number => text.split(needle).length - 1;

describe('appendEvent: casos límite', () => {
  it('un «ß» en el calendario existente no rompe el fichero (toUpperCase alarga el texto)', async () => {
    writeFileSync(
      file,
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        'UID:viejo',
        'SUMMARY:Cena en la Straße',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n'),
    );
    await appendEvent(file, { uid: 'nuevo', title: 'Dentista', start: START });
    const out = lines(readFileSync(file, 'utf8'));
    expect(out.at(-1)).toBe('END:VCALENDAR');
    expect(out).not.toContain('E');
    expect(out.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(2);
    expect(out.filter((l) => l === 'END:VEVENT')).toHaveLength(2);
    expect(out).toContain('SUMMARY:Dentista');
    expect(out).toContain('SUMMARY:Cena en la Straße');
  });

  it('el mismo UID dos veces actualiza el evento en vez de duplicarlo', async () => {
    await appendEvent(file, { uid: 'cita', title: 'Dentista', start: START });
    await appendEvent(file, { uid: 'otra', title: 'Otra', start: START });
    await appendEvent(file, { uid: 'cita', title: 'Dentista (cambiada)', start: START });
    const ics = readFileSync(file, 'utf8');
    expect(count(ics, 'BEGIN:VEVENT')).toBe(2);
    expect(count(ics, 'UID:cita')).toBe(1);
    expect(ics).toContain('SUMMARY:Dentista (cambiada)');
    expect(ics).not.toContain('SUMMARY:Dentista\r\n');
    // Repetir exactamente la misma orden (sin uid explícito) tampoco duplica.
    await appendEvent(file, { title: 'Gimnasio', start: START });
    await appendEvent(file, { title: 'Gimnasio', start: START });
    expect(count(readFileSync(file, 'utf8'), 'SUMMARY:Gimnasio')).toBe(1);
  });

  it('cinco añadidos a la vez no se pisan: están los cinco', async () => {
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        appendEvent(file, { uid: `e${n}`, title: `Evento ${n}`, start: START }),
      ),
    );
    const ics = readFileSync(file, 'utf8');
    for (const n of [1, 2, 3, 4, 5]) expect(ics).toContain(`UID:e${n}`);
    expect(count(ics, 'BEGIN:VCALENDAR')).toBe(1);
    expect(count(ics, 'END:VCALENDAR')).toBe(1);
  });

  it('un fallo en un añadido no bloquea los siguientes', async () => {
    await expect(appendEvent(file, { title: '  ', start: START })).rejects.toThrow(/título/);
    await appendEvent(file, { uid: 'ok', title: 'Bien', start: START });
    expect(readFileSync(file, 'utf8')).toContain('UID:ok');
  });

  it('reconoce el cierre en minúsculas y con espacios finales', async () => {
    writeFileSync(file, 'begin:vcalendar\r\nVERSION:2.0\r\nend:vcalendar  \r\n');
    await appendEvent(file, { uid: 'x', title: 'X', start: START });
    const out = lines(readFileSync(file, 'utf8'));
    expect(out.filter((l) => /^end:vcalendar/i.test(l))).toHaveLength(1);
    expect(out.indexOf('UID:x')).toBeLessThan(out.findIndex((l) => /^end:vcalendar/i.test(l)));
  });
});
