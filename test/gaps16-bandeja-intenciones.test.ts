import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IntencionesStore, textoAviso, textoDeGuardado } from '../src/intenciones.js';

const NOW = Date.UTC(2026, 10, 11, 18, 0);
const CHAT = 'telegram:default:42';
let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-gaps16-bandeja-intenciones-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const item = (over: Partial<Parameters<typeof textoDeGuardado>[0]> = {}) => ({
  title: 'Resultados del tercer trimestre',
  note: null,
  reason: 'Sube el beneficio un 12 %',
  ideas: ['Indra gana contratos de defensa'],
  extra: { author: 'Expansión', tags: ['bolsa'] },
  ...over,
});

describe('gaps-16: lo que guardas en la bandeja también «habla de» un tema', () => {
  it('textoDeGuardado junta título, nota, por qué, ideas, autor y temas (sin URL)', () => {
    const t = textoDeGuardado(item({ note: 'para el viernes' }));
    expect(t).toContain('Resultados del tercer trimestre');
    expect(t).toContain('para el viernes');
    expect(t).toContain('Indra gana contratos');
    expect(t).toContain('Expansión');
    expect(t).toContain('bolsa');
    expect(textoDeGuardado(item({ title: null, reason: null, ideas: [], extra: {} }))).toBe('');
  });

  it('un artículo guardado de Indra dispara «cuando hable de Indra…» y lo dice', () => {
    const s = new IntencionesStore(join(dir, 'intenciones.json'));
    const i = s.crear(CHAT, ['Indra'], 'mirar el dividendo', NOW - 3_600_000);
    if (i === 'lleno') throw new Error('lleno');
    const [aviso] = s.disparar(CHAT, textoDeGuardado(item()), NOW);
    expect(aviso?.id).toBe(i.id);
    if (!aviso) throw new Error('sin aviso');
    expect(textoAviso(aviso, { guardado: 'Resultados del tercer trimestre' })).toBe(
      '💡 Lo que acabas de guardar («Resultados del tercer trimestre») habla de «Indra». Me pediste que te recordara: mirar el dividendo.',
    );
    // Otro chat u otro tema: nada.
    expect(s.disparar('telegram:default:7', textoDeGuardado(item()), NOW + 2 * 86_400_000)).toEqual(
      [],
    );
    expect(
      s.disparar(CHAT, textoDeGuardado(item({ ideas: ['Telefónica'] })), NOW + 2 * 86_400_000),
    ).toEqual([]);
  });

  it('cli: al acabar de leer una cosa de la bandeja, solo del dueño, con «🔕»', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');
    const d = src.indexOf('onDone: async (item) => {');
    expect(src.slice(d, d + 300)).toContain('await bandejaIntenciones(item)');
    const f = src.indexOf('const bandejaIntenciones = async');
    const body = src.slice(f, f + 1400);
    expect(body).toContain("item.status !== 'listo' || item.chatId !== briefingOwner()");
    expect(body).toContain('it.OLVIDAR_LABEL');
  });
});
