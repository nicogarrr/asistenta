import { describe, expect, it } from 'vitest';
import { formatApproval } from '../src/approval-text.js';
import { prepareSignup } from '../src/credentials/signup.js';
import type { VaultOps } from '../src/credentials/store.js';
import { Gate } from '../src/permissions.js';
import { createAccountsTool } from '../src/tools/accounts.js';

function memVault(): VaultOps & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return {
    m,
    get: async (k) => m.get(k),
    set: async (k, v) => {
      m.set(k, v);
    },
    delete: async (k) => m.delete(k),
    list: async () => [...m.keys()],
  };
}
const ME = { name: 'Nico', email: 'nico@example.com' };
const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

/** Lo que hace el agente: pista para la Gate, pregunta al dueño y, con su sí, la llamada. */
async function discard(v: VaultOps, args: Record<string, unknown>, before?: () => Promise<void>) {
  const tool = createAccountsTool(v, async () => ME);
  const hint = await tool.gateHint(args);
  const question = formatApproval(
    { tool: 'cuentas', actor: 'local', args: hint ? { ...args, _target: hint } : args },
    'x',
  ).question;
  await before?.();
  return { question, text: text(await tool.execute('t', args as never)) };
}

describe('descartar un alta desde el chat: antes pregunta, con la web exacta', () => {
  it('la Gate pregunta cada vez (borra la contraseña guardada del alta)', async () => {
    let asked = 0;
    const gate = new Gate({
      approver: () => {
        asked += 1;
        return true;
      },
    });
    const go = {
      tool: 'cuentas',
      args: { action: 'descartar', sitio: 'wallapop' },
      actor: 'local',
    } as const;
    expect((await gate.check('s', go)).verdict).toBe('allow');
    gate.settle('s', go, false);
    await gate.check('s', go);
    expect(asked).toBe(2);
  });

  it('con el nombre a secas, la pregunta ya nombra la web exacta', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', ME, {}, v);
    const r = await discard(v, { action: 'descartar', sitio: 'wallapop' });
    expect(r.question).toContain('wallapop.es');
    expect(r.question).toMatch(/descart/i);
    expect(r.question).not.toMatch(/\bwallapop\b(?!\.es)/);
    expect(r.text).toContain('wallapop.es');
    expect(v.m.size).toBe(0);
  });

  it('si entre la pregunta y la llamada cambia la web que encaja, no borra nada', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', ME, {}, v);
    const r = await discard(v, { action: 'descartar', sitio: 'wallapop' }, async () => {
      // Ahora encajan dos: no se puede saber cuál quería el dueño.
      await prepareSignup('es.wallapop.com', ME, {}, v);
    });
    expect(r.question).toContain('wallapop.es');
    expect(v.m.get('site:wallapop.es:password')).toBeTruthy();
    expect(v.m.get('site:es.wallapop.com:password')).toBeTruthy();
  });

  it('la descripción dice que el nombre a secas vale', () => {
    const tool = createAccountsTool(memVault(), async () => ME);
    expect(tool.description).toMatch(/bare name/i);
    expect(tool.description).toMatch(/wallapop\.es/);
  });
});
