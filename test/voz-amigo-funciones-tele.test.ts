import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { funcionesText } from '../src/funciones.js';
import { tvButtonCommand } from '../src/tv/tv-chat-command.js';

// Nico (1 nov): «como estamos hablando nosotros». Quedaban «Prueba /funciones a
// secas para ver todas» y «Escribe /tv para sacar el mando».
describe('funciones y botones de la tele sin mandar a comandos', () => {
  it('un área que no existe nombra las que hay, en líneas cortas', () => {
    const text = funcionesText({ owner: true }, 'xyzzy');
    expect(text.split('\n')[0]).toBe('No conozco el área «xyzzy». Tengo estas:');
    expect(text).toContain('📺 Tele');
    expect(text).not.toContain('/funciones');
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(90);
  });

  it('un botón de la tele que ya no vale dice qué decir con palabras', async () => {
    const r = await tvButtonCommand('tv:no-existe', { isOwner: true } as Parameters<
      typeof tvButtonCommand
    >[1]);
    expect(r).toBe(
      'Ese botón ya no existe. Dime qué hago con la tele, por ejemplo «abre Netflix».',
    );
    const tg = readFileSync('src/channels/telegram.ts', 'utf8');
    expect(tg).not.toContain('Escribe /tv para sacar el mando');
  });
});
