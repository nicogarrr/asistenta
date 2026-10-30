import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { taintEmailTurn } from '../src/channels/email.js';
import { Gate } from '../src/permissions.js';

function gate() {
  const asked: string[] = [];
  const g = new Gate({
    protectedPaths: [],
    allow: ['fetch'],
    egressTaint: true,
    approver: (_c, reason) => {
      asked.push(reason);
      return true;
    },
  });
  return { g, asked };
}

describe('turno que entra por correo (F10): externo y privado', () => {
  it('una petición con datos a un dominio nuevo pregunta tras un turno de correo', async () => {
    const { g, asked } = gate();
    taintEmailTurn(g, 's');
    expect(g.privateTaintOf('s')).toMatch(/correo/);
    await g.check('s', {
      tool: 'fetch',
      args: { url: 'https://nuevo.example/x?d=hola123' },
      actor: 'me',
    });
    expect(asked).toHaveLength(1);
  });

  it('sin turno de correo, la misma petición no pregunta (sin cambio)', async () => {
    const { g, asked } = gate();
    await g.check('s', {
      tool: 'fetch',
      args: { url: 'https://nuevo.example/x?d=hola123' },
      actor: 'me',
    });
    expect(asked).toHaveLength(0);
  });

  it('el daemon lo usa para los turnos del canal de correo', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/EMAIL_CHANNEL\) taintEmailTurn\(thread\.gate, thread\.key\)/);
  });
});
