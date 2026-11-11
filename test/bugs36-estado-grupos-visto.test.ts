// bugs-36 (revisión de gaps-15 #2367, «Grupos donde estoy» en /estado): el «visto» de un
// grupo solo se reescribía una vez al día, para no tocar el fichero con cada mensaje. Así un
// grupo que acababa de hablar podía salir con «último mensaje ayer».
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatTitulos } from '../src/chat-titulos.js';
import { gruposEstado } from '../src/status.js';

describe('/estado: el último mensaje de un grupo es el de verdad', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-bugs36-titulos-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('un grupo que habló hace un minuto sale «hoy», y el orden es del último en hablar', () => {
    let now = Date.parse('2026-11-10T09:00:00Z');
    const t = new ChatTitulos(join(dir, 'chat-titulos.json'), () => now);
    t.recordar('telegram:default:-100111', 'Familia');
    t.recordar('telegram:default:-100222', 'Inversores');
    now = Date.parse('2026-11-11T08:00:00Z'); // 23 h después
    t.recordar('telegram:default:-100111', 'Familia');
    const lista = t.lista();
    expect(lista.map((g) => g.titulo)).toEqual(['Familia', 'Inversores']);
    expect(gruposEstado(lista, now + 60_000)[0]).toBe('«Familia» (último mensaje hoy)');
  });

  it('sigue sin reescribir el fichero con cada mensaje del mismo día', () => {
    let now = Date.parse('2026-11-11T08:00:00Z');
    const t = new ChatTitulos(join(dir, 'chat-titulos.json'), () => now);
    expect(t.recordar('telegram:default:-100111', 'Familia')).toBe(true);
    now += 3_600_000;
    expect(t.recordar('telegram:default:-100111', 'Familia')).toBe(false);
  });
});
