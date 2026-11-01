import { describe, expect, it } from 'vitest';
import { formatApproval } from '../src/approval-text.js';
import { prepareSignup } from '../src/credentials/signup.js';
import type { VaultOps } from '../src/credentials/store.js';
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
const approved = (v: { m: Map<string, string> }, d: string): boolean =>
  typeof (JSON.parse(v.m.get(`cuenta:${d}`) ?? '{}') as { approvedAt?: unknown }).approvedAt ===
  'number';

/** Lo que hace el agente: pista para la Gate, pregunta al dueño y, con su sí, la llamada. */
async function confirm(
  v: VaultOps,
  args: Record<string, unknown>,
  beforeRun?: () => Promise<void>,
) {
  const tool = createAccountsTool(v, async () => ME);
  const hint = await tool.gateHint(args);
  const question = formatApproval(
    { tool: 'cuentas', actor: 'local', args: hint ? { ...args, _target: hint } : args },
    'x',
  ).question;
  await beforeRun?.();
  const r = await tool.execute('t', args as never);
  return { question, text: (r.content[0] as { text: string }).text };
}

describe('confirmar un alta con el nombre a secas: un solo sí', () => {
  it('la pregunta nombra la web exacta y ese sí basta', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', ME, {}, v);
    const { question, text } = await confirm(v, {
      action: 'confirmar_registro',
      sitio: 'wallapop',
      correo: ME.email,
    });
    expect(question).toContain('tu cuenta en wallapop.es');
    expect(text).toMatch(/^Aprobado .*wallapop\.es/);
    expect(approved(v, 'wallapop.es')).toBe(true);
  });

  it('con dos webs parecidas no hay pista ni aprobación: pregunta cuál', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', ME, {}, v);
    await prepareSignup('es.wallapop.com', ME, {}, v);
    const { question, text } = await confirm(v, {
      action: 'confirmar_registro',
      sitio: 'wallapop',
      correo: ME.email,
    });
    expect(question).not.toMatch(/wallapop\.es|wallapop\.com/);
    expect(text).toMatch(/dime cuál/);
    expect(approved(v, 'wallapop.es')).toBe(false);
    expect(approved(v, 'es.wallapop.com')).toBe(false);
  });

  it('si entre la pregunta y la llamada aparece otra web parecida, no aprueba ninguna', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', ME, {}, v);
    const { question, text } = await confirm(
      v,
      { action: 'confirmar_registro', sitio: 'wallapop', correo: ME.email },
      async () => {
        await prepareSignup('es.wallapop.com', ME, {}, v);
      },
    );
    expect(question).toContain('wallapop.es');
    expect(text).toMatch(/dime cuál/);
    expect(approved(v, 'wallapop.es')).toBe(false);
  });

  it('sin la pregunta de la Gate, el nombre a secas sigue sin aprobar nada', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', ME, {}, v);
    const tool = createAccountsTool(v, async () => ME);
    const r = await tool.execute('t', {
      action: 'confirmar_registro',
      sitio: 'wallapop',
      correo: ME.email,
    } as never);
    expect((r.content[0] as { text: string }).text).toMatch(/sitio=wallapop\.es/);
    expect(approved(v, 'wallapop.es')).toBe(false);
  });

  it('otro correo distinto del preparado no aprueba aunque la web cuadre', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', ME, {}, v);
    const { text } = await confirm(v, {
      action: 'confirmar_registro',
      sitio: 'wallapop',
      correo: 'otro@example.com',
    });
    expect(text).toMatch(/no es el del registro/);
    expect(approved(v, 'wallapop.es')).toBe(false);
  });

  it('leer el código también pregunta por la web exacta', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', ME, {}, v);
    const tool = createAccountsTool(v, async () => ME);
    const args = { action: 'codigo_registro', sitio: 'wallapop' };
    const hint = await tool.gateHint(args);
    expect(
      formatApproval({ tool: 'cuentas', actor: 'local', args: { ...args, _target: hint } }, 'x')
        .question,
    ).toContain('te ha mandado wallapop.es');
  });

  it('una pista que no es una web no cambia la pregunta', () => {
    const q = formatApproval(
      {
        tool: 'cuentas',
        actor: 'local',
        args: {
          action: 'confirmar_registro',
          sitio: 'wallapop.es',
          correo: ME.email,
          _target: '[destino ilegible]',
        },
      },
      'x',
    ).question;
    expect(q).toContain('tu cuenta en wallapop.es con');
  });
});
