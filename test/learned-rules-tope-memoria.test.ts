import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LEARNED_TAG, learnedRules, saveLearnedRule } from '../src/memory/learned-rules.js';
import { MAX_MEMORY_BYTES, MemoryStore, PINNED_MEMORY_TAGS } from '../src/memory.js';

// Una memoria de chat llena (64 KB) echaba primero lo más antiguo, y las reglas
// aprendidas suelen ser lo más antiguo: desaparecían de /aprendido sin aviso.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function store(): MemoryStore {
  const d = mkdtempSync(join(tmpdir(), 'pa-tope-'));
  dirs.push(d);
  return new MemoryStore(d);
}

function llenar(m: MemoryStore, scope: string): void {
  const relleno = 'nota larga sobre la compra de la semana y otras cosas de casa '.repeat(28);
  const veces = Math.ceil((MAX_MEMORY_BYTES * 1.5) / relleno.length);
  for (let i = 0; i < veces; i++) m.remember(scope, `${i}: ${relleno}`);
}

describe('tope de la memoria del chat y reglas aprendidas', () => {
  it('las reglas aprendidas sobreviven cuando el archivo del chat se llena', () => {
    const m = store();
    const scope = 'telegram:1';
    expect(saveLearnedRule(m, scope, 'Responde siempre en frases cortas').status).toBe('saved');
    expect(saveLearnedRule(m, scope, 'Avísame 10 minutos antes de cada cita').status).toBe('saved');
    llenar(m, scope);
    const textos = learnedRules(m, [scope]).map((r) => r.text);
    expect(textos).toContain('Responde siempre en frases cortas');
    expect(textos).toContain('Avísame 10 minutos antes de cada cita');
  });

  it('se siguen echando los hechos normales más antiguos', () => {
    const m = store();
    const scope = 'telegram:2';
    m.remember(scope, 'hecho viejo');
    llenar(m, scope);
    expect(m.recall(scope, 'hecho viejo', 50).some((e) => e.text === 'hecho viejo')).toBe(false);
  });

  it('la etiqueta protegida es la de las reglas aprendidas', () => {
    expect(PINNED_MEMORY_TAGS).toContain(LEARNED_TAG);
  });
});
