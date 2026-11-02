import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type MemoryEntry, MemoryStore, panelMemoryEntries } from '../src/memory.js';
import {
  MAX_ENLACES,
  MAX_ENLACES_POR_NODO,
  mapaMemoria,
  TOPE_NODOS,
} from '../src/webui/mapa-memoria.js';
import { renderPage } from '../src/webui/page.js';
import { startWebUi, type WebUiDeps } from '../src/webui/server.js';

function e(
  id: string,
  text: string,
  tags: string[] = [],
  over: Partial<MemoryEntry> = {},
): MemoryEntry {
  return { id, date: '2026-11-01', text, tags, supersedes: [], supersededBy: null, ...over };
}

const TARJETA = '4111 1111 1111 1111';

function enlaceEntre(m: ReturnType<typeof mapaMemoria>, a: string, b: string) {
  const ia = m.nodos.findIndex((n) => n.id === a);
  const ib = m.nodos.findIndex((n) => n.id === b);
  return m.enlaces.find((l) => (l.a === ia && l.b === ib) || (l.a === ib && l.b === ia));
}

describe('mapa de memoria: nodos y enlaces', () => {
  it('une por etiqueta, por [[enlace]], por nombre propio compartido y por reemplazo', () => {
    const m = mapaMemoria([
      e('m1', 'Nico va al gimnasio los martes', ['salud']),
      e('m2', 'Nico toma magnesio por la noche', ['Salud']),
      e('m3', 'Nico: el viaje a Lisboa es en diciembre'),
      e('m4', 'Reservar hotel para [[viaje a Lisboa]]'),
      e('m5', 'Nico dice que su hermana Marta vive en Oviedo'),
      e('m6', 'Marta cumple años el 3 de mayo'),
      e('m7', 'Prefiere café solo', [], { supersedes: ['m8'] }),
      e('m8', 'Prefiere café con leche'),
    ]);
    expect(enlaceEntre(m, 'm1', 'm2')).toMatchObject({ tipo: 'etiqueta', motivo: '#salud' });
    expect(enlaceEntre(m, 'm3', 'm4')).toMatchObject({ tipo: 'enlace' });
    expect(enlaceEntre(m, 'm3', 'm4')?.motivo).toContain('[[viaje a Lisboa]]');
    expect(enlaceEntre(m, 'm5', 'm6')).toMatchObject({ tipo: 'mencion', motivo: 'marta' });
    expect(enlaceEntre(m, 'm7', 'm8')).toMatchObject({ tipo: 'reemplaza' });
    // «Nico» sale en casi todo: no une por sí solo.
    expect(enlaceEntre(m, 'm1', 'm5')).toBeUndefined();
    expect(enlaceEntre(m, 'm3', 'm5')).toBeUndefined();
    expect(m).toMatchObject({ total: 8, recortado: false, tope: TOPE_NODOS, ocultos: 0 });
    for (const n of m.nodos)
      expect(Object.keys(n).sort()).toEqual(['etiquetas', 'fecha', 'grado', 'id', 'texto']);
  });

  it('solo recuerdos vigentes; los que parecen una clave o tarjeta no salen nunca', () => {
    const m = mapaMemoria([
      e('a', 'Vigente'),
      e('b', 'Sustituido', [], { supersededBy: 'a' }),
      e('c', `pago con ${TARJETA}`),
      e('d', 'nota normal', [TARJETA]),
    ]);
    expect(m.nodos.map((n) => n.id)).toEqual(['a']);
    expect(m.ocultos).toBe(2);
    expect(JSON.stringify(m)).not.toContain('4111');
  });

  it('tope: los 300 más recientes, y lo dice', () => {
    const muchos = Array.from({ length: 350 }, (_, i) =>
      e(`m${i}`, `recuerdo ${i}`, [], {
        date: `2026-${String(1 + Math.floor(i / 30)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
      }),
    );
    const m = mapaMemoria(muchos);
    expect(m.nodos).toHaveLength(300);
    expect(m).toMatchObject({ total: 350, recortado: true, tope: 300 });
    const fechas = m.nodos.map((n) => n.fecha);
    expect([...fechas].sort().reverse()).toEqual(fechas);
    expect(fechas[0]).toBe('2026-12-28');
    expect(mapaMemoria(muchos, 10).nodos).toHaveLength(10);
  });

  it('una etiqueta común no dibuja una maraña: enlaces por nodo y totales con tope', () => {
    const m = mapaMemoria(Array.from({ length: 300 }, (_, i) => e(`m${i}`, `cosa ${i}`, ['casa'])));
    expect(m.enlaces.length).toBeLessThanOrEqual(MAX_ENLACES);
    expect(m.enlaces.length).toBeLessThanOrEqual(300 * MAX_ENLACES_POR_NODO);
    for (const l of m.enlaces) {
      expect(l.a).toBeGreaterThanOrEqual(0);
      expect(l.b).toBeLessThan(300);
      expect(l.a).not.toBe(l.b);
    }
  });

  it('con la memoria de verdad (MemoryStore en una carpeta temporal)', () => {
    const memory = new MemoryStore(mkdtempSync(join(tmpdir(), 'pa-mapa-')));
    memory.remember('telegram:dm:7#main', 'Le gusta el senderismo', { tags: ['ocio'] });
    memory.remember('telegram:dm:7#main', 'Hace rutas por los Picos de Europa', { tags: ['ocio'] });
    memory.remember('telegram:dm:99#main', 'De otra persona', { tags: ['ocio'] });
    const m = mapaMemoria(panelMemoryEntries(memory, undefined, 7));
    expect(m.nodos.map((n) => n.texto).sort()).toEqual([
      'Hace rutas por los Picos de Europa',
      'Le gusta el senderismo',
    ]);
    expect(m.enlaces).toHaveLength(1);
  });
});

describe('mapa de memoria: ruta y tarjeta', () => {
  const base: WebUiDeps = {
    token: 'test-only',
    status: () => ({}),
    sessions: () => [],
    memory: () => [],
    auditVerify: () => ({}),
  };
  const headers = { Authorization: 'Bearer test-only' };

  it('GET /api/mapa-memoria pide token, 503 sin datos, solo GET, pasa el ámbito y no filtra claves', async () => {
    const sin = await startWebUi(base);
    try {
      expect((await fetch(`${sin.url}/api/mapa-memoria`, { headers })).status).toBe(503);
    } finally {
      await sin.close();
    }
    const vistos: (string | undefined)[] = [];
    const ui = await startWebUi({
      ...base,
      mapaMemoria: (scope) => {
        vistos.push(scope);
        return mapaMemoria([
          e('a', 'uno', ['x']),
          e('b', 'dos', ['x']),
          e('c', `clave ${TARJETA}`),
        ]);
      },
    });
    try {
      expect((await fetch(`${ui.url}/api/mapa-memoria`)).status).toBe(401);
      expect((await fetch(`${ui.url}/api/mapa-memoria`, { method: 'POST', headers })).status).toBe(
        405,
      );
      const ok = await fetch(`${ui.url}/api/mapa-memoria?scope=local`, { headers });
      expect(ok.status).toBe(200);
      const datos = (await ok.json()) as ReturnType<typeof mapaMemoria>;
      expect(datos.nodos).toHaveLength(2);
      expect(datos.enlaces).toEqual([{ a: 0, b: 1, peso: 2, tipo: 'etiqueta', motivo: '#x' }]);
      expect(datos.ocultos).toBe(1);
      expect(JSON.stringify(datos)).not.toContain('4111');
      expect(vistos).toEqual(['local']);
    } finally {
      await ui.close();
    }
  });

  it('el panel tiene la tarjeta, la dibuja en SVG propio (sin librerías ni red) y la busca', () => {
    const html = renderPage();
    expect(html).toContain('<h2 id="titulo-mapa">Mapa de memoria</h2>');
    expect(html).toContain('id="buscar-mapa"');
    expect(html).toContain("'/api/mapa-memoria'");
    expect(html).toContain('mapa: cargarMapa');
    expect(html).toContain('cargarMapa(),');
    expect(html).toContain('createElementNS(SVG_NS, etiqueta)');
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
  });
});
