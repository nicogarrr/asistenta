import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addHypothesis, readHypotheses } from '../src/evolve/run.js';
import { addRule, loadRules } from '../src/mail/rules.js';
import { parseModelo } from '../src/model-choice.js';

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const dir = () => mkdtempSync(join(tmpdir(), 'bugs20-cortes-'));

// asis-bugs-20: textos que se guardan o se enseñan recortados a ciegas; un emoji justo
// en el corte dejaba medio carácter («�» en Telegram).
describe('cortes sin medio emoji: reglas de correo, /modelo e ideas de /evolucion', () => {
  it('regla de correo: texto (300) y remitente/asunto (120)', () => {
    const file = join(dir(), 'rules.json');
    const saved = addRule(
      {
        texto: `${'t'.repeat(299)}📦 paquetes`,
        remitente: `${'r'.repeat(119)}📦 tienda`,
        asunto: `${'a'.repeat(119)}📦 pedido`,
        accion: 'archivar',
      } as never,
      file,
    );
    expect(typeof saved).not.toBe('string');
    const [r] = loadRules(file);
    expect(r?.texto).toBe('t'.repeat(299));
    expect(r?.remitente).toBe('r'.repeat(119));
    expect(r?.asunto).toBe('a'.repeat(119));
    expect(JSON.stringify(r)).not.toMatch(LONE);
  });

  it('/modelo con un nombre desconocido largo', () => {
    const r = parseModelo(`${'m'.repeat(59)}🤖 modelo`, ['a/b', 'c/d']);
    expect(r.kind).toBe('error');
    const text = r.kind === 'error' ? r.text : '';
    expect(text).toContain(`«${'m'.repeat(59)}»`);
    expect(text).not.toMatch(LONE);
  });

  it('/evolucion idea larga', () => {
    const state = dir();
    addHypothesis(state, `${'i'.repeat(299)}💡 idea`);
    expect(readHypotheses(state)).toEqual(['i'.repeat(299)]);
  });
});
