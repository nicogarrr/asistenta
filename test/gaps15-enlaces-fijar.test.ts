import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bibliotecaOrden } from '../src/biblioteca.js';
import { commandButton, commandFromCallback } from '../src/channels/telegram-shared.js';
import {
  claveEnlace,
  ENLACES_MAX_FIJADOS,
  EnlacesFijados,
  enlacesConFijados,
  enlacesVista,
  textoFijarEnlace,
} from '../src/enlaces-enviados.js';

const TZ = 'Europe/Madrid';
const NOW = Date.UTC(2026, 10, 11, 16, 0);
const e = (url: string, etiqueta = '', at = NOW - 3_600_000) => ({ url, etiqueta, at });
let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-gaps15-enlaces-fijar-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('gaps-15: 📌 fijar enlaces en «/biblioteca enlaces» (Grok Bot «Pin»)', () => {
  it('órdenes: «enlaces fijar 3», «links soltar 1» y el botón con la clave', () => {
    expect(bibliotecaOrden('enlaces fijar 3')).toEqual({ kind: 'enlace-pin', fijar: true, n: 3 });
    expect(bibliotecaOrden('links soltar 1')).toEqual({ kind: 'enlace-pin', fijar: false, n: 1 });
    const k = claveEnlace('https://www.expansion.com/mercados/indra.html');
    expect(bibliotecaOrden(`fijarenlace ${k}`)).toEqual({
      kind: 'enlace-pin',
      fijar: true,
      n: 0,
      clave: k,
    });
    expect(bibliotecaOrden('enlaces')).toEqual({ kind: 'enlaces' });
    // Los de archivos siguen igual.
    expect(bibliotecaOrden('fijar 3')).toEqual({ kind: 'fijar', n: 3 });
    const b = commandButton('📌 1', 'biblioteca', k, 'fijarenlace');
    expect(commandFromCallback(b?.action ?? '')).toBe(`/biblioteca fijarenlace ${k}`);
  });

  it('la clave no cambia con «www.», la barra final o mayúsculas, y cabe en un botón', () => {
    const a = claveEnlace('https://www.idealista.com/inmueble/123/');
    expect(a).toBe(claveEnlace('https://idealista.com/inmueble/123'));
    expect(a).toMatch(/^[0-9a-f]{10}$/);
  });

  it('fijar, «ya», tope, soltar; por chat; sobrevive a reabrir', () => {
    const file = join(dir, 'enlaces-fijados.json');
    const f = new EnlacesFijados(file);
    const piso = e('https://www.idealista.com/inmueble/123/', 'El piso de Chamberí');
    expect(f.fijar('tg:1', piso)).toBe('ok');
    expect(f.fijar('tg:1', piso)).toBe('ya');
    expect(new EnlacesFijados(file).lista('tg:1')).toHaveLength(1);
    expect(f.lista('tg:2')).toEqual([]);
    for (let i = 0; i < ENLACES_MAX_FIJADOS - 1; i++) f.fijar('tg:1', e(`https://x.example/${i}`));
    expect(f.fijar('tg:1', e('https://x.example/sobra'))).toBe('lleno');
    expect(f.soltar('tg:1', claveEnlace(piso.url))?.etiqueta).toBe('El piso de Chamberí');
    expect(f.soltar('tg:1', claveEnlace(piso.url))).toBeNull();
    expect(JSON.parse(readFileSync(file, 'utf8'))['tg:1']).toHaveLength(ENLACES_MAX_FIJADOS - 1);
  });

  it('la lista: lo fijado arriba con 📌 (aunque ya no esté entre los últimos), sin repetir', () => {
    const fijo = e('https://www.idealista.com/inmueble/123', 'El piso', NOW - 20 * 86_400_000);
    const recientes = [
      e('https://www.expansion.com/indra', 'Indra'),
      e('https://idealista.com/inmueble/123/', 'El piso'),
    ];
    const todos = enlacesConFijados(recientes, [fijo]);
    expect(todos.map((x) => x.fijado)).toEqual([true, false]);
    const v = enlacesVista(recientes, NOW, TZ, [fijo]);
    expect(v.text).toContain('📌 Fijados:\n1. 📌 El piso — idealista.com');
    expect(v.text).toContain('Los últimos:\n2. Indra — expansion.com');
    expect(v.pins.map((p) => [p.label, p.sub])).toEqual([
      ['Soltar 1', 'soltarenlace'],
      ['📌 2', 'fijarenlace'],
    ]);
    expect(v.buttons.map((b) => b.label)).toEqual(['🔗 1', '🔗 2']);
    // Sin fijados, como antes (y con su «📌 N»).
    const sin = enlacesVista(recientes, NOW, TZ);
    expect(sin.text).not.toContain('📌 Fijados');
    expect(sin.pins).toHaveLength(2);
  });

  it('textos', () => {
    const x = e('https://www.expansion.com/indra', 'Indra sube');
    expect(textoFijarEnlace(true, x, 'ok')).toMatch(/^📌 Fijado «Indra sube \(expansion\.com\)»/);
    expect(textoFijarEnlace(false, x, true)).toBe('Suelto «Indra sube (expansion.com)».');
    expect(textoFijarEnlace(true, null, false)).toMatch(/^No tengo ese enlace/);
  });

  it('cli: los fijados se guardan por chat en enlaces-fijados.json', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');
    expect(src).toContain("new en.EnlacesFijados(join(paths.state, 'enlaces-fijados.json'))");
  });
});
