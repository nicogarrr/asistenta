import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatTitulos } from '../src/chat-titulos.js';
import { ESTADO_GRUPOS_MAX, formatStatus, gruposEstado } from '../src/status.js';

const DIA = 86_400_000;
const NOW = Date.UTC(2026, 10, 11, 16, 0);
let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-gaps15-estado-grupos-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const base = {
  version: 'dev',
  node: 'v24',
  uptimeMs: 60_000,
  tools: [],
  log: null,
  pageWatches: 0,
} as unknown as Parameters<typeof formatStatus>[0];

describe('gaps-15: /estado dice en qué grupos estoy, por su nombre', () => {
  it('lista() del más reciente al más viejo, sin hilos repetidos', () => {
    let t = NOW - 10 * DIA;
    const ct = new ChatTitulos(join(dir, 'chat-titulos.json'), () => t);
    ct.recordar('telegram:main:-1001', 'Inversores');
    t = NOW - DIA;
    ct.recordar('telegram:main:-1002:7', 'Familia');
    ct.recordar('telegram:main:-1002:9', 'Familia');
    expect(ct.lista().map((g) => g.titulo)).toEqual(['Familia', 'Inversores']);
  });

  it('cada grupo con cuándo habló por última vez', () => {
    expect(
      gruposEstado(
        [
          { titulo: 'Familia', visto: NOW - 3_600_000 },
          { titulo: 'Pádel', visto: NOW - DIA - 5 },
          { titulo: 'Inversores', visto: NOW - 40 * DIA },
        ],
        NOW,
      ),
    ).toEqual([
      '«Familia» (último mensaje hoy)',
      '«Pádel» (último mensaje ayer)',
      '«Inversores» (último mensaje hace 40 días)',
    ]);
  });

  it('con muchos, un tope y «y N más»', () => {
    const muchos = Array.from({ length: ESTADO_GRUPOS_MAX + 3 }, (_, i) => ({
      titulo: `G${i}`,
      visto: NOW,
    }));
    const l = gruposEstado(muchos, NOW);
    expect(l).toHaveLength(ESTADO_GRUPOS_MAX + 1);
    expect(l.at(-1)).toBe('…y 3 más');
  });

  it('formatStatus pone la sección; sin grupos, nada', () => {
    const con = formatStatus({ ...base, grupos: ['«Familia» (último mensaje hoy)'] });
    expect(con).toContain('Grupos donde estoy:\n- «Familia» (último mensaje hoy)');
    expect(formatStatus(base)).not.toContain('Grupos donde estoy');
    expect(gruposEstado([], NOW)).toEqual([]);
  });

  it('cli: solo al dueño en privado (en un grupo no se cuentan los demás)', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');
    expect(src).toContain(
      'const grupos = isOwnerDm(inbound, vigilanteOwnerId) ? gruposEstado(chatTitulos.lista()) : [];',
    );
  });
});
