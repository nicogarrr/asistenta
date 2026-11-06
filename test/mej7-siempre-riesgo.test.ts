import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ofreceAlcance } from '../src/daemon/gate.js';

// Un shell arriesgado nunca guarda un permiso reutilizable, pero la pregunta de Telegram
// seguía ofreciendo «Siempre» (y «Por ahora»): Nico lo pulsaba y la siguiente vez volvía
// a preguntar. Ahora esos botones solo salen donde valen.

const shell = (command: string) => ({ tool: 'shell', args: { command } });

describe('aprobaciones: «Siempre» solo en órdenes de shell no arriesgadas', () => {
  it('un shell arriesgado no ofrece «Siempre» ni «Por ahora»', () => {
    expect(ofreceAlcance(shell('rm -rf C:\\Users\\nico\\Descargas'))).toBe(false);
    expect(ofreceAlcance(shell('npm install left-pad'))).toBe(false);
    expect(ofreceAlcance(shell('powershell -EncodedCommand ZQBjAGgAbwA='))).toBe(false);
  });

  it('un shell no arriesgado y las demás herramientas sí lo ofrecen', () => {
    expect(ofreceAlcance(shell('git log --oneline -5'))).toBe(true);
    expect(ofreceAlcance({ tool: 'correo', args: { action: 'leer' } })).toBe(true);
  });

  it('el gate lo pasa a Telegram y Telegram pinta solo «Permitir/Denegar»', () => {
    const gate = readFileSync(new URL('../src/daemon/gate.ts', import.meta.url), 'utf8');
    expect(gate).toContain('conAlcance: ofreceAlcance(call)');
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toContain('askScope: extra?.conAlcance !== false');
  });

  it('docs/taint-gate.md documenta PA_APROBAR_SIEMPRE', () => {
    const doc = readFileSync(new URL('../docs/taint-gate.md', import.meta.url), 'utf8');
    expect(doc).toContain('PA_APROBAR_SIEMPRE=0');
    expect(doc).toContain('solo\n  ofrece «Permitir» y «Denegar»');
  });
});
