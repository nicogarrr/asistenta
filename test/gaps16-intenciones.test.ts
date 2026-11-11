import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandButton, commandFromCallback } from '../src/channels/telegram-shared.js';
import {
  atenderIntenciones,
  IntencionesStore,
  intencionesOrden,
  intencionIntent,
  OLVIDAR_LABEL,
} from '../src/intenciones.js';

const NOW = Date.UTC(2026, 10, 11, 18, 0);
const DIA = 86_400_000;
let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-gaps16-intenciones-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('gaps-16: recordatorios por tema, frase al revés', () => {
  it('«recuérdame X cuando hable de Y» se entiende igual', () => {
    expect(intencionIntent('Recuérdame mirar el dividendo cuando hable de Indra')).toEqual({
      claves: ['Indra'],
      texto: 'mirar el dividendo',
    });
    expect(intencionIntent('pregúntame por su viaje si menciono a Ana o a Luis.')).toEqual({
      claves: ['Ana', 'Luis'],
      texto: 'su viaje',
    });
    expect(
      intencionIntent('dime que llame al banco cada vez que salga el tema de la hipoteca'),
    ).toEqual({ claves: ['hipoteca'], texto: 'llame al banco' });
    expect(intencionIntent('avísame de devolverle el libro, cuando hable con Marta')).toEqual({
      claves: ['Marta'],
      texto: 'devolverle el libro',
    });
  });

  it('no se traga lo que no es suyo', () => {
    // Llegar/salir de casa es llegada.ts.
    expect(intencionIntent('recuérdame sacar la basura cuando llegue a casa')).toBeNull();
    expect(intencionIntent('recuérdame algo cuando hable de casa')).toBeNull();
    // Un recordatorio por hora sigue yendo al modelo.
    expect(intencionIntent('recuérdame mañana a las 9 llamar a Ana')).toBeNull();
    // Al revés, el tema es corto: una frase entera detrás no es un tema.
    expect(
      intencionIntent(
        'recuérdame el libro cuando hable con Pedro para que me lo devuelva el lunes',
      ),
    ).toBeNull();
  });
});

describe('gaps-16: «🔕 No me lo recuerdes más»', () => {
  it('el botón lleva el id y quita ESA intención aunque la lista cambie', () => {
    const s = new IntencionesStore(join(dir, 'intenciones.json'));
    const a = s.crear('tg:1', ['Indra'], 'mirar el dividendo', NOW);
    const b = s.crear('tg:1', ['Ana'], 'su viaje', NOW);
    if (a === 'lleno' || b === 'lleno') throw new Error('lleno');
    const btn = commandButton(OLVIDAR_LABEL, 'intenciones', String(b.id), 'olvidar');
    expect(btn?.label).toBe('🔕 No me lo recuerdes más');
    const orden = commandFromCallback(btn?.action ?? '');
    expect(orden).toBe(`/intenciones olvidar ${b.id}`);
    expect(intencionesOrden(`olvidar ${b.id}`)).toEqual({ kind: 'olvidar', id: b.id });
    // La primera se quita a mano antes del toque: el id sigue apuntando a la de Ana.
    s.quitar('tg:1', 1, NOW);
    expect(s.quitarId('tg:1', b.id)?.texto).toBe('su viaje');
    expect(s.lista('tg:1', NOW)).toEqual([]);
    // Segundo toque (o de otro chat): nada.
    expect(s.quitarId('tg:1', b.id)).toBeNull();
  });

  it('otro chat no puede quitarla con el id', () => {
    const s = new IntencionesStore(join(dir, 'intenciones.json'));
    const a = s.crear('tg:1', ['Indra'], 'mirar el dividendo', NOW);
    if (a === 'lleno') throw new Error('lleno');
    expect(s.quitarId('tg:2', a.id)).toBeNull();
    expect(s.lista('tg:1', NOW)).toHaveLength(1);
  });

  it('el aviso del texto y de la voz lleva el botón (cli.ts)', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');
    expect(src).toContain(
      "commandButton(it.OLVIDAR_LABEL, 'intenciones', String(i.id), 'olvidar')",
    );
    expect(src).toContain("if (orden.kind === 'olvidar')");
  });
});

describe('gaps-16: intenciones desde notas de voz', () => {
  it('la transcripción crea y dispara igual que lo escrito', () => {
    const s = new IntencionesStore(join(dir, 'intenciones.json'));
    // «Cuando hable de Indra recuérdame mirar el dividendo», dicho (whisper sin comas).
    const r = atenderIntenciones(
      s,
      'tg:1',
      'Cuando hable de Indra recuérdame mirar el dividendo.',
      NOW,
    );
    expect(r.creada).toMatchObject({ claves: ['Indra'], texto: 'mirar el dividendo' });
    expect(r.avisos).toEqual([]);
    // Al día siguiente, una nota que nombra Indra.
    const r2 = atenderIntenciones(s, 'tg:1', 'oye, ¿cómo va hoy Indra en bolsa?', NOW + DIA);
    expect(r2.creada).toBeNull();
    expect(r2.avisos.map((i) => i.texto)).toEqual(['mirar el dividendo']);
  });

  it('lo reenviado no crea (no lo dijo él), pero sí avisa', () => {
    const s = new IntencionesStore(join(dir, 'intenciones.json'));
    const r = atenderIntenciones(s, 'tg:1', 'cuando hable de Indra, recuérdame vender', NOW, {
      crear: false,
    });
    expect(r.creada).toBeNull();
    expect(s.lista('tg:1', NOW)).toEqual([]);
    s.crear('tg:1', ['Indra'], 'mirar el dividendo', NOW);
    const r2 = atenderIntenciones(s, 'tg:1', 'Indra sube un 3 %', NOW + DIA, { crear: false });
    expect(r2.avisos).toHaveLength(1);
  });

  it('el camino de voz llama al ayudante con lo oído, solo en el privado del dueño', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');
    const voz = src.indexOf('atenderIntencionesDe(inbound, heard.text, tell)');
    expect(voz).toBeGreaterThan(0);
    const antes = src.slice(voz - 400, voz);
    expect(antes).toContain('isOwnerDm(inbound, vigilanteOwnerId)');
    expect(antes).toContain('!opts.external');
    expect(src).toContain('crear: !inbound.forwardedFrom');
  });
});
