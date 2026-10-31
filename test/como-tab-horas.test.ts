import { describe, expect, it } from 'vitest';
import { ownerQuietHours } from '../src/memory/owner-quiet.js';
import { inQuietHours } from '../src/ojo.js';

const said = (s: string) => `[dicho] ${s}`;

describe('horas en que el dueño dijo que no le escriban', () => {
  it('sin nada dicho: las de serie (22–8)', () => {
    expect(ownerQuietHours([])).toEqual({ startHour: 22, endHour: 8 });
  });

  it('«no me escribas antes de las 9» mueve el final a las 9', () => {
    expect(ownerQuietHours([said('No me escribas antes de las 9')])).toEqual({
      startHour: 22,
      endHour: 9,
    });
  });

  it('«después de las 11» es de noche: empieza a las 23', () => {
    expect(ownerQuietHours([said('No me mandes nada después de las 11')])).toEqual({
      startHour: 23,
      endHour: 8,
    });
  });

  it('«antes de las 9 y media» calla hasta las 10', () => {
    expect(ownerQuietHours([said('No me escribas antes de las 9 y media')]).endHour).toBe(10);
    expect(ownerQuietHours([said('No me escribas antes de las 8:30')]).endHour).toBe(9);
  });

  it('gana lo último dicho y se combinan principio y final', () => {
    const q = ownerQuietHours([
      said('No me escribas antes de las 10'),
      said('No me escribas después de las 10 de la noche'),
      said('No me escribas antes de las 9'),
    ]);
    expect(q).toEqual({ startHour: 22, endHour: 9 });
  });

  it('solo cuenta lo que dijo él ([dicho]), no lo autoguardado ni otras frases', () => {
    expect(ownerQuietHours(['[auto] No me escribas antes de las 11'])).toEqual({
      startHour: 22,
      endHour: 8,
    });
    expect(ownerQuietHours([said('Mi dentista es el Dr. García')])).toEqual({
      startHour: 22,
      endHour: 8,
    });
  });

  it('un silencio absurdo (más de 16 h) no se aplica', () => {
    expect(ownerQuietHours([said('No me escribas antes de las 17')])).toEqual({
      startHour: 22,
      endHour: 8,
    });
  });

  it('a las 8:30 ya no molesta de serie, pero sí si dijo «antes de las 9»', () => {
    const at = Date.UTC(2026, 9, 31, 7, 30); // 8:30 en Madrid (UTC+1)
    expect(inQuietHours(at, ownerQuietHours([]), 'Europe/Madrid')).toBe(false);
    expect(
      inQuietHours(at, ownerQuietHours([said('No me escribas antes de las 9')]), 'Europe/Madrid'),
    ).toBe(true);
  });

  it('cli.ts usa sus horas en el vigilante y en el «¿qué tal fue?»', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/quiet: \(now\) => inQuietHours\(now, ownerQuiet\(\), localTimeZone\(\)\)/);
    expect(src).toMatch(/get quiet\(\) \{\s*return ownerQuiet\(\);/);
  });
});
