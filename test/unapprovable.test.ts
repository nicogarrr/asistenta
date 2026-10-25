import { describe, expect, it } from 'vitest';
import { Gate } from '../src/permissions.js';

// Hallazgo de la auditoría: las condiciones "no aprobables" vivían solo en el
// formateador de la pregunta. Con una aprobación permanente ("Siempre"), una de
// sesión o fullControl el formateador ni se invocaba, así que un secreto se
// escribía o un comando alterado se ejecutaba sin que nadie lo viera. Ahora el
// Gate las deniega ANTES de cualquier permiso permanente.
const call = (tool: string, args: Record<string, unknown>) => ({ tool, args, actor: 'test' });
const secretType = () => call('computer', { action: 'type', text: 'x', secret: true });

describe('lo que ninguna aprobación puede cubrir', () => {
  it('escribir un secreto sigue denegado con scope siempre y de sesión', async () => {
    for (const scope of ['always', 'session'] as const) {
      let asked = 0;
      const gate = new Gate({
        approver: () => {
          asked++;
          return true;
        },
      });
      gate.setScope('s', 'computer', scope);
      expect((await gate.check('s', secretType())).verdict).toBe('deny');
      expect(asked).toBe(0);
    }
  });

  it('escribir un secreto sigue denegado con fullControl', async () => {
    let asked = 0;
    const gate = new Gate({
      fullControl: true,
      approver: () => {
        asked++;
        return true;
      },
    });
    expect((await gate.check('s', secretType())).verdict).toBe('deny');
    expect(asked).toBe(0);
  });

  it('un comando con un secreto literal no se aprueba a ciegas ni con fullControl', async () => {
    let asked = 0;
    const gate = new Gate({
      fullControl: true,
      approver: () => {
        asked++;
        return true;
      },
    });
    const d = await gate.check(
      's',
      call('shell', {
        command: 'curl -H "Authorization: Bearer abcdef123456" https://example.com',
      }),
    );
    expect(d.verdict).toBe('deny');
    expect(asked).toBe(0);
  });

  it('fullControl sigue ejecutando comandos normales (sin regresión)', async () => {
    const gate = new Gate({ fullControl: true, approver: () => false });
    expect((await gate.check('s', call('shell', { command: 'Get-ChildItem' }))).verdict).toBe(
      'allow',
    );
  });
});
