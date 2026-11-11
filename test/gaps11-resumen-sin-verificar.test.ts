import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import {
  compactHistory,
  countUnverified,
  extractionPrompt,
  hasUnverified,
  parseExtractedFacts,
  SUMMARY_WARNING,
  summaryPrompt,
  UNVERIFIED_TAG,
  UNVERIFIED_WARNING,
} from '../src/core/history.js';

const user = (t: string) =>
  ({ role: 'user', content: [{ type: 'text', text: t }], timestamp: 1 }) as unknown as AgentMessage;
const asst = (t: string) =>
  ({ role: 'assistant', content: [{ type: 'text', text: t }] }) as unknown as AgentMessage;
const long = () => [user('x'.repeat(8_000)), asst('y'.repeat(8_000)), user('hola'), asst('ok')];
const o = { triggerTokens: 500, keepRecentTokens: 100 };
const noteText = (m: AgentMessage | undefined) => JSON.stringify(m);

describe('resumen de conversaciones largas: lo no comprobado va marcado (Hermes UNVERIFIED)', () => {
  it('el prompt del resumen pide marcar lo no comprobado y conservar las marcas previas', () => {
    const p = summaryPrompt({ transcript: 'assistant: ASTS vale 28 $', splitTurn: false });
    expect(p).toContain(`«${UNVERIFIED_TAG}»`);
    expect(p).toContain('sin una línea "resultado:" que lo respalde');
    expect(p).toContain('conserva sus marcas');
  });

  it('si el resumen trae marcas, la nota avisa de comprobarlas; si no, no', async () => {
    const marked = await compactHistory(
      long(),
      async () => 'Hecho y resultados: SIN VERIFICAR: el correo al gestor se envió.',
      o,
    );
    expect(noteText(marked.messages[0])).toContain(UNVERIFIED_WARNING);
    expect(noteText(marked.messages[0])).toContain(SUMMARY_WARNING);
    const clean = await compactHistory(long(), async () => 'Objetivo: X', o);
    expect(noteText(clean.messages[0])).not.toContain(UNVERIFIED_WARNING);
  });

  it('al re-resumir, el aviso no se cuela en el resumen previo pero las marcas sí', async () => {
    const first = await compactHistory(long(), async () => 'Datos: SIN VERIFICAR: precio 12 €', o);
    const more = [
      ...first.messages,
      user('z'.repeat(8_000)),
      asst('w'.repeat(8_000)),
      user('fin'),
      asst('ya'),
    ];
    let seen = '';
    await compactHistory(
      more,
      async (p) => {
        seen = p;
        return 'Objetivo: SEGUNDO';
      },
      o,
    );
    expect(seen).toContain('SIN VERIFICAR: precio 12 €');
    expect(seen).not.toContain(UNVERIFIED_WARNING);
  });

  it('lo marcado nunca pasa a la memoria durable, aunque el extractor lo devuelva', () => {
    const facts = parseExtractedFacts(
      JSON.stringify([
        'Nico prefiere los resúmenes en español',
        'SIN VERIFICAR: la reunión con el banco es el 14',
        'UNVERIFIED: Nico tiene 300 acciones de ASTS',
        'El gestor se llama Pablo (no verificado: el apellido)',
      ]),
    );
    // También un hecho con una parte «no verificado»: la memoria durable no guarda dudas.
    expect(facts).toEqual(['Nico prefiere los resúmenes en español']);
    expect(extractionPrompt({ transcript: 'user: hola', existingFacts: [] })).toContain(
      'NO extraigas lo que no está comprobado',
    );
  });

  it('detecta y cuenta las marcas en sus formas', () => {
    expect(hasUnverified('Pendiente: nada')).toBe(false);
    expect(hasUnverified('- sin verificar: x')).toBe(true);
    expect(countUnverified('SIN VERIFICAR: a\nNO VERIFICADO: b\nUNVERIFIED: c\nok')).toBe(3);
  });
});
