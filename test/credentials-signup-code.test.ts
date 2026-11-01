import { describe, expect, it } from 'vitest';
import { formatApproval } from '../src/approval-text.js';
import { approveSignup, prepareSignup } from '../src/credentials/signup.js';
import {
  type CodeMail,
  extractSignupCode,
  findSignupCode,
  SIGNUP_CODE_WINDOW_MS,
} from '../src/credentials/signup-code.js';
import type { VaultOps } from '../src/credentials/store.js';
import { Gate } from '../src/permissions.js';
import { createAccountsTool } from '../src/tools/accounts.js';

function memVault(): VaultOps {
  const map = new Map<string, string>();
  return {
    get: async (k) => map.get(k),
    set: async (k, v) => {
      map.set(k, v);
    },
    delete: async (k) => map.delete(k),
    list: async () => [...map.keys()],
  };
}
const ME = { name: 'Nico García', email: 'nico@example.com' };

async function approved() {
  const v = memVault();
  await prepareSignup('wallapop.es', ME, {}, v);
  await approveSignup('wallapop.es', ME.email, v);
  return v;
}
const mail = (over: Partial<CodeMail>): CodeMail => ({
  from: 'no-reply@wallapop.es',
  subject: 'Verifica tu cuenta',
  at: Date.now(),
  text: '',
  ...over,
});

describe('extractSignupCode', () => {
  it('saca el código junto a «código» o en el asunto', () => {
    expect(extractSignupCode('Bienvenido', 'Tu código de verificación es: 482913.')).toEqual({
      code: '482913',
    });
    expect(extractSignupCode('731204 es tu código de Wallapop', '')).toEqual({ code: '731204' });
  });
  it('nunca mira dentro de un enlace; si solo hay enlace, lo dice', () => {
    expect(
      extractSignupCode(
        'Confirma tu correo',
        'Pulsa https://wallapop.es/verify?code=123456 para confirmar',
      ),
    ).toEqual({ linkOnly: true });
  });
});

describe('cuentas codigo_registro: el código del alta desde el correo', () => {
  it('con el alta aprobada, devuelve solo los dígitos del correo de esa web', async () => {
    const v = await approved();
    const r = await findSignupCode(
      'wallapop.es',
      async () => [
        mail({ from: 'promo@otra.com', text: 'código 999999' }),
        mail({ text: 'Hola Nico, tu código es 482913. Entra en https://wallapop.es/x' }),
      ],
      v,
    );
    expect(r).toMatch(/482913/);
    expect(r).not.toMatch(/999999|http/);
  });

  it('sin alta aprobada (o aprobada hace más de 30 min) no lee el correo', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', ME, {}, v);
    let read = 0;
    const search = async () => {
      read += 1;
      return [mail({ text: 'código 482913' })];
    };
    expect(await findSignupCode('wallapop.es', search, v)).toMatch(/confirmar_registro/);
    const v2 = await approved();
    expect(
      await findSignupCode('wallapop.es', search, v2, Date.now() + SIGNUP_CODE_WINDOW_MS + 60_000),
    ).toMatch(/confirmar_registro/);
    expect(await findSignupCode('amazon.es', search, v2)).toMatch(/ningún alta/);
    expect(read).toBe(0);
  });

  it('un correo anterior a la aprobación no vale', async () => {
    const v = await approved();
    const r = await findSignupCode(
      'wallapop.es',
      async () => [mail({ at: Date.now() - 3_600_000, text: 'código 111111' })],
      v,
    );
    expect(r).toMatch(/Todavía no ha llegado/);
  });

  it('si la web manda un enlace, no lo abre y se lo pasa al dueño', async () => {
    const v = await approved();
    const r = await findSignupCode(
      'wallapop.es',
      async () => [mail({ text: 'Confirma aquí: https://wallapop.es/c/abc' })],
      v,
    );
    expect(r).toMatch(/No abro enlaces/);
    expect(r).not.toMatch(/http/);
  });

  it('sin correo configurado lo dice en llano', async () => {
    const v = await approved();
    expect(await findSignupCode('wallapop.es', async () => null, v)).toMatch(
      /pídele al dueño el código/,
    );
  });

  it('la herramienta acepta la acción y usa el lector inyectado', async () => {
    const v = await approved();
    const tool = createAccountsTool(
      v,
      async () => ME,
      async () => [mail({ text: 'code: 555123' })],
    );
    const r = await tool.execute('t', { action: 'codigo_registro', sitio: 'wallapop.es' } as never);
    expect(JSON.stringify(r)).toMatch(/555123/);
  });
});

describe('Gate: leer el código se pregunta cada vez', () => {
  it('pregunta siempre, con una frase clara', async () => {
    let asked = 0;
    const gate = new Gate({
      approver: () => {
        asked += 1;
        return true;
      },
    });
    const go = {
      tool: 'cuentas',
      args: { action: 'codigo_registro', sitio: 'wallapop.es' },
      actor: 'local',
    } as const;
    await gate.check('s', go);
    gate.settle('s', go, false);
    await gate.check('s', go);
    expect(asked).toBe(2);
    const t = formatApproval(go, "reads a sign-up verification code from the owner's mail");
    expect(JSON.stringify(t)).toMatch(
      /Voy a mirar en tu correo el código que te ha mandado wallapop\.es/,
    );
  });
});
