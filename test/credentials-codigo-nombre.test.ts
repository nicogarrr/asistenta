import { describe, expect, it } from 'vitest';
import { approveSignup, prepareSignup } from '../src/credentials/signup.js';
import { type CodeMail, findSignupCode } from '../src/credentials/signup-code.js';
import type { VaultOps } from '../src/credentials/store.js';

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
const ME = { name: 'Nico', email: 'nico@example.com' };
const mail = (over: Partial<CodeMail>): CodeMail => ({
  from: 'no-reply@wallapop.es',
  subject: 'Verifica tu cuenta',
  at: Date.now(),
  text: 'Tu código es 482913.',
  ...over,
});

describe('codigo_registro con solo el nombre de la web', () => {
  it('«el código de wallapop» lee el del alta aprobada de wallapop.es', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', ME, {}, v);
    await approveSignup('wallapop.es', ME.email, v);
    const r = await findSignupCode('Wallapop', async () => [mail({})], v);
    expect(r).toMatch(/Código de wallapop\.es: 482913/);
  });

  it('si encajan dos webs distintas, pregunta cuál y no lee el correo', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', ME, {}, v);
    await approveSignup('wallapop.es', ME.email, v);
    await prepareSignup('es.wallapop.com', ME, {}, v);
    let read = 0;
    const r = await findSignupCode(
      'wallapop',
      async () => {
        read += 1;
        return [mail({})];
      },
      v,
    );
    expect(r).toMatch(/dime cuál/);
    expect(read).toBe(0);
  });

  it('un dominio exacto distinto no se mezcla: wallapop.com no lee lo de wallapop.es', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', ME, {}, v);
    await approveSignup('wallapop.es', ME.email, v);
    expect(await findSignupCode('wallapop.com', async () => [mail({})], v)).toMatch(/ningún alta/);
  });

  it('el nombre a secas sin el sí del dueño sigue sin leer nada', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', ME, {}, v);
    expect(await findSignupCode('wallapop', async () => [mail({})], v)).toMatch(
      /wallapop\.es no está aprobada/,
    );
  });
});
