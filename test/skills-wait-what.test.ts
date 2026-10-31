import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REPITCH_INSTRUCTION, repitchText, wantsRepitch } from '../src/skills/wait-what.js';

describe('«no te he entendido» (wait-what)', () => {
  it.each([
    'no te entiendo',
    'No te he entendido',
    '¿cómo?',
    'qué?',
    'uf, no lo pillo',
    'explícamelo más fácil',
    'Explícamelo de otra forma.',
    'en cristiano',
    'no me he enterado',
  ])('«%s» pide re-explicar', (t) => {
    expect(wantsRepitch(t)).toBe(true);
  });

  it.each([
    'cómo está el tráfico para ir a Oviedo',
    'qué tiempo hace',
    'no entiendo por qué el PDF sale vacío, revisa el OCR y dime qué pasa',
    'explícame qué es un ETF',
    'pon la tele',
    '',
  ])('«%s» no', (t) => {
    expect(wantsRepitch(t)).toBe(false);
  });

  it('el modelo recibe la instrucción fija y lo que escribió Nico', () => {
    const out = repitchText(' ¿cómo? ');
    expect(out.startsWith(REPITCH_INSTRUCTION)).toBe(true);
    expect(out).toContain('«¿cómo?»');
    expect(REPITCH_INSTRUCTION).toMatch(/sencillas/);
    expect(REPITCH_INSTRUCTION).toMatch(/5 líneas/);
  });

  it('en el chat solo se aplica si ya hubo conversación en el hilo', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const at = cli.indexOf('wantsRepitch(inbound.text)');
    expect(at).toBeGreaterThan(cli.indexOf('const thread = await resolveThread(inbound);'));
    expect(cli.slice(at - 120, at)).toContain('thread.agent.messages.length > 0');
    expect(cli.slice(at, at + 120)).toContain('inbound.text = repitchText(inbound.text)');
  });
});
