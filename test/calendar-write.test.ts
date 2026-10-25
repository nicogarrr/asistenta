import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendEvent, toIcsEvent } from '../src/agenda/write.js';

const dirs: string[] = [];

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pa-calendar-write-'));
  dirs.push(dir);
  return join(dir, 'calendario', 'agenda.ics');
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const START = new Date('2026-03-04T08:00:00Z');
const END = new Date('2026-03-04T09:00:00Z');

describe('toIcsEvent', () => {
  it('escribe las fechas en UTC y escapa el texto de RFC 5545', () => {
    const ics = toIcsEvent({
      uid: 'uid-1',
      title: 'Reunión, sala 3; piso 2',
      start: START,
      end: END,
      location: 'Calle Mayor, 4; 2º',
      description: 'Linea 1\nLinea 2\\fin',
    });

    expect(ics.split('\r\n')[0]).toBe('BEGIN:VEVENT');
    expect(ics.endsWith('END:VEVENT')).toBe(true);
    expect(ics).toContain('UID:uid-1');
    expect(ics).toContain('DTSTAMP:20260304T080000Z');
    expect(ics).toContain('DTSTART:20260304T080000Z');
    expect(ics).toContain('DTEND:20260304T090000Z');
    expect(ics).toContain('SUMMARY:Reunión\\, sala 3\\; piso 2');
    expect(ics).toContain('LOCATION:Calle Mayor\\, 4\\; 2º');
    expect(ics).toContain('DESCRIPTION:Linea 1\\nLinea 2\\\\fin');
    expect(ics).not.toContain('\n\n');
  });

  it('sin end no inventa DTEND; el UID derivado es estable', () => {
    const first = toIcsEvent({ title: 'Llamar al gestor', start: START });
    const second = toIcsEvent({ title: 'Llamar al gestor', start: START });
    const other = toIcsEvent({ title: 'Otra cosa', start: START });

    expect(first).toBe(second);
    expect(first).not.toContain('DTEND');
    expect(first).toMatch(/UID:[0-9a-f]{20}@asistenta\.local/);
    expect(other).not.toBe(first);
  });

  it('rechaza fechas inválidas y un final anterior al inicio', () => {
    expect(() => toIcsEvent({ title: 'X', start: new Date(Number.NaN) })).toThrow(/start/);
    expect(() => toIcsEvent({ title: 'X', start: START, end: new Date(Number.NaN) })).toThrow(
      /end/,
    );
    expect(() =>
      toIcsEvent({ title: 'X', start: START, end: new Date(START.getTime() - 1) }),
    ).toThrow(/anterior/);
    expect(() => toIcsEvent({ title: '   ', start: START })).toThrow(/título/);
  });
});

describe('appendEvent', () => {
  it('crea un VCALENDAR con el evento cuando el fichero no existe', async () => {
    const file = tempFile();
    await appendEvent(file, { title: 'Primera', start: START, end: END });

    const ics = readFileSync(file, 'utf8');
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('VERSION:2.0');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('SUMMARY:Primera');
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(count(ics, 'BEGIN:VCALENDAR')).toBe(1);
    expect(count(ics, 'END:VCALENDAR')).toBe(1);
  });

  it('añade al final sin duplicar la cabecera ni perder el evento anterior', async () => {
    const file = tempFile();
    await appendEvent(file, { uid: 'uno', title: 'Primera', start: START });
    await appendEvent(file, { uid: 'dos', title: 'Segunda', start: END });

    const ics = readFileSync(file, 'utf8');
    expect(count(ics, 'BEGIN:VCALENDAR')).toBe(1);
    expect(count(ics, 'END:VCALENDAR')).toBe(1);
    expect(count(ics, 'BEGIN:VEVENT')).toBe(2);
    expect(ics.indexOf('UID:uno')).toBeLessThan(ics.indexOf('UID:dos'));
    expect(ics.indexOf('UID:dos')).toBeLessThan(ics.indexOf('END:VCALENDAR'));
  });

  it('respeta un .ics existente y repara una cabecera sin cierre', async () => {
    const file = tempFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        'UID:viejo',
        'SUMMARY:Viejo',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n'),
      'utf8',
    );

    await appendEvent(file, { uid: 'nuevo', title: 'Nuevo', start: START });
    const ics = readFileSync(file, 'utf8');
    expect(count(ics, 'BEGIN:VCALENDAR')).toBe(1);
    expect(ics.indexOf('UID:viejo')).toBeLessThan(ics.indexOf('UID:nuevo'));
    expect(ics).toContain('SUMMARY:Viejo');
    expect(ics).toContain('SUMMARY:Nuevo');

    const truncated = tempFile();
    mkdirSync(dirname(truncated), { recursive: true });
    writeFileSync(truncated, 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n', 'utf8');
    await appendEvent(truncated, { uid: 'reparado', title: 'Reparado', start: START });
    const repaired = readFileSync(truncated, 'utf8');
    expect(count(repaired, 'BEGIN:VCALENDAR')).toBe(1);
    expect(count(repaired, 'END:VCALENDAR')).toBe(1);
    expect(repaired.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
  });

  it('envuelve contenido sin cabecera en vez de descartarlo', async () => {
    const file = tempFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'BEGIN:VEVENT\r\nUID:suelto\r\nSUMMARY:Suelto\r\nEND:VEVENT\r\n', 'utf8');

    await appendEvent(file, { uid: 'nuevo', title: 'Nuevo', start: START });
    const ics = readFileSync(file, 'utf8');
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(count(ics, 'BEGIN:VCALENDAR')).toBe(1);
    expect(ics).toContain('UID:suelto');
    expect(ics).toContain('UID:nuevo');
  });

  it('la escritura es atómica: no deja temporales en el directorio', async () => {
    const file = tempFile();
    await appendEvent(file, { title: 'Uno', start: START });
    expect(readdirSync(dirname(file))).toEqual(['agenda.ics']);
  });
});
