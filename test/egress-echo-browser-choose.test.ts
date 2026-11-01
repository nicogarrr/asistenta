import { describe, expect, it } from 'vitest';
import { Gate } from '../src/permissions.js';

function gate() {
  const asked: string[] = [];
  const g = new Gate({
    protectedPaths: [],
    allow: ['mail', 'browser'],
    egressTaint: true,
    approver: (_c, reason) => {
      asked.push(reason);
      return true;
    },
  });
  return { g, asked };
}

const MAIL = { tool: 'mail', args: { action: 'read', id: '1' }, actor: 'me' };
const BODY = 'Hola Nico. Te espero en la Calle del Pez 14, portal 3B, a las 19:30. Un abrazo.';
const ECHO = 'Calle del Pez 14, portal 3B';

async function afterMail(args: Record<string, unknown>) {
  const { g, asked } = gate();
  await g.check('s', MAIL);
  g.settle('s', MAIL, false, BODY);
  await g.check('s', { tool: 'browser', args, actor: 'me' });
  return asked;
}

describe('eco del contenido privado en choose/pick/press del navegador', () => {
  it('choose con el texto o la sugerencia del correo pregunta', async () => {
    expect(await afterMail({ action: 'choose', selector: '#q', text: ECHO })).toHaveLength(1);
    expect(
      await afterMail({ action: 'choose', selector: '#q', text: 'Madrid', option: ECHO }),
    ).toHaveLength(1);
  });

  it('pick con la etiqueta del correo pregunta', async () => {
    expect(await afterMail({ action: 'pick', from: '#q', with: ECHO })).toHaveLength(1);
  });

  it('press con el texto del correo pregunta', async () => {
    expect(await afterMail({ action: 'press', selector: '#q', key: ECHO })).toHaveLength(1);
  });

  it('valores normales no preguntan', async () => {
    expect(await afterMail({ action: 'press', selector: '#q', key: 'Enter' })).toHaveLength(0);
    expect(
      await afterMail({
        action: 'choose',
        selector: '#q',
        text: 'Madrid',
        option: 'Madrid Chamartín',
      }),
    ).toHaveLength(0);
  });
});
