import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PreguntasPendientes, SI_RESPUESTA } from '../src/daemon/pregunta-pendiente.js';
import { corteAnswer, corteAsk, MIC_CLOSED_ASK } from '../src/wake-texts.js';

// Nico (1 nov): que Asistenta hable como un amigo, sin mandarle a comandos.
const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');

describe('/conversacion estado y corte sin mandar a /conversacion', () => {
  it('el micrófono cerrado pregunta y «sí» lo abre', () => {
    expect(MIC_CLOSED_ASK).toBe(' El micrófono está cerrado. ¿Lo abro? Dime «sí».');
    expect(cli).not.toContain('/conversacion on lo abre');
    expect(cli).toContain("(currentWake()?.isRunning() ? '' : MIC_CLOSED_ASK) +");
    expect(cli).toContain(
      'if (!currentWake()?.isRunning()) askConversacion(inbound, micOpenAnswer);',
    );
    expect(cli).toContain(
      "const micOpenAnswer = (t: string): string | null => (SI_RESPUESTA.test(t) ? 'on' : null);",
    );
    const p = new PreguntasPendientes();
    p.ask('c', 'conversacion', { answer: (t) => (SI_RESPUESTA.test(t) ? 'on' : null) });
    expect(p.consume('c', 'sí')).toEqual({ name: 'conversacion', args: 'on' });
  });

  it('el corte se cambia diciendo «con auriculares», «con altavoces» o «sin corte»', () => {
    const t = corteAsk('altavoces');
    expect(t).not.toMatch(/\/\w/);
    expect(t).toContain('¿Lo cambio? Dime «con auriculares», «con altavoces» o «sin corte»');
    expect(cli).not.toContain('Para cambiarlo: /conversacion corte');
    expect(cli).toContain('askConversacion(inbound, corteAnswer);');
    expect(corteAnswer('con auriculares')).toBe('corte auriculares');
    expect(corteAnswer('Altavoces.')).toBe('corte altavoces');
    expect(corteAnswer('sin corte')).toBe('corte off');
    expect(corteAnswer('que no me cortes')).toBe('corte off');
    expect(corteAnswer('qué tal')).toBeNull();
    const p = new PreguntasPendientes();
    p.ask('c', 'conversacion', { answer: corteAnswer });
    expect(p.consume('c', 'con auriculares')).toEqual({
      name: 'conversacion',
      args: 'corte auriculares',
    });
  });
});
