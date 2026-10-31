import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Nico (31 oct): que Asistenta hable como en un chat. /conversacion estado y
// /conversacion corte sin «clasificadas», «falsas estimadas», «sesión abierta»
// ni el error en crudo.
const cli = readFileSync('src/cli.ts', 'utf8');

describe('/conversacion en castellano llano', () => {
  it('estado: sin la jerga de las estadísticas de cortes', () => {
    expect(cli).not.toContain('Sesión abierta (');
    expect(cli).not.toContain('Histórico de cortes');
    expect(cli).not.toContain('uso estimado, ');
    expect(cli).not.toContain('rechazados por el detector');
    expect(cli).toContain('Ahora estamos hablando: ');
    expect(cli).toContain('sin querer (ruido o eco)');
    expect(cli).toContain(' En total me has cortado ');
  });

  it('estado: no pega el error en crudo', () => {
    expect(cli).not.toContain('último fallo: ');
    expect(cli).toContain("' La última vez algo falló al oírte.'");
  });

  it('cómo acabó la última conversación, dicho en llano', () => {
    expect(cli).not.toMatch(/lastConversationEnd = `\$\{reason\}/);
    expect(cli).toContain("'porque dejaste de hablar'");
    expect(cli).toContain("'porque no conseguía entenderte'");
  });

  it('corte: sin «clasificadas» ni «estimación por transcripción»', () => {
    expect(cli).not.toContain('Es una estimación por transcripción');
    expect(cli).toContain(' Hasta ahora me has cortado ');
  });
});
