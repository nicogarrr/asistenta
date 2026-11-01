import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Nico (1 nov): que Asistenta hable como un amigo, sin mandarle a comandos.
const page = readFileSync(new URL('../src/webui/page.ts', import.meta.url), 'utf8');

describe('la tarjeta «Qué sé hacer» del panel', () => {
  it('no remite a /funciones de Telegram', () => {
    expect(page).not.toContain('Lo mismo que /funciones en Telegram');
    expect(page).toContain('Qué sé hacer, por áreas, con un ejemplo de cómo pedírmelo.');
  });
});
