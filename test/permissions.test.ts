import { describe, expect, it } from 'vitest';
import { Gate, isEffectText, lexicalNormalize } from '../src/permissions.js';
import { checkoutStageOf } from '../src/tools/checkout.js';

const allow = () => true;
const deny = () => false;

describe('Gate', () => {
  it('allows an allow-listed tool without asking', async () => {
    const gate = new Gate({ allow: ['read'], approver: deny });
    const d = await gate.check('s1', { tool: 'read', args: { path: 'a.txt' }, actor: 'local' });
    expect(d.verdict).toBe('allow');
  });

  it('denies a deny-listed tool even when an approver would say yes', async () => {
    // The point of a deny list is that it cannot be talked around.
    const gate = new Gate({ allow: ['shell'], deny: ['shell'], approver: allow });
    const d = await gate.check('s1', { tool: 'shell', args: { command: 'rm' }, actor: 'local' });
    expect(d.verdict).toBe('deny');
  });

  it('refuses to write to a protected path', async () => {
    const gate = new Gate({
      allow: ['write'],
      protectedPaths: ['C:\\Users\\nicoi\\.ssh'],
      approver: allow,
    });
    const blocked = await gate.check('s1', {
      tool: 'write',
      args: { path: 'C:\\Users\\nicoi\\.ssh\\id_rsa', content: 'x' },
      actor: 'local',
    });
    expect(blocked.verdict).toBe('deny');

    // Prefix match must not catch a sibling directory with a similar name.
    const sibling = await gate.check('s2', {
      tool: 'write',
      args: { path: 'C:\\Users\\nicoi\\.ssh-backup\\id_rsa', content: 'x' },
      actor: 'local',
    });
    expect(sibling.verdict).toBe('allow');
  });

  it('fails closed when there is no approver to ask', async () => {
    const gate = new Gate({ allow: ['read'] });
    const d = await gate.check('s1', { tool: 'shell', args: { command: 'dir' }, actor: 'cron' });
    expect(d.verdict).toBe('deny');
    expect(d.reason).toContain('unattended');
  });

  it('remembers an approval for the session but not across sessions', async () => {
    let asked = 0;
    const gate = new Gate({
      allow: ['read'],
      approver: () => {
        asked++;
        return true;
      },
    });
    const call = { tool: 'computer', args: { action: 'click', x: 1, y: 1 }, actor: 'local' };

    await gate.check('s1', call);
    await gate.check('s1', call);
    expect(asked).toBe(1);

    await gate.check('s2', call);
    expect(asked).toBe(2);
  });

  it('does not treat a different action as approved', async () => {
    // grantWindowMs: 0 disables the task-wide trust window so this measures the
    // per-call fingerprint on its own.
    const gate = new Gate({ allow: ['read'], grantWindowMs: 0, approver: () => true });
    await gate.check('s1', {
      tool: 'computer',
      args: { action: 'click', x: 1, y: 1 },
      actor: 'local',
    });
    const d = await gate.check('s1', {
      tool: 'computer',
      args: { action: 'click', x: 9, y: 9 },
      actor: 'local',
    });
    expect(d.reason).toBe('approved by local');
    // The point: a different coordinate is a different fingerprint, so it re-asks.
    expect(d.verdict).toBe('allow');
  });

  it('asks before anything that looks like payment or credentials', async () => {
    const prompts: string[] = [];
    const gate = new Gate({
      // No allow entry for shell, so every call is a distinct gate decision rather
      // than landing in the shell grant window.
      grantWindowMs: 0,
      approver: (_call, reason) => {
        prompts.push(reason);
        return true;
      },
    });
    await gate.check('s1', {
      tool: 'shell',
      args: { command: 'type card 4111111111111111' },
      actor: 'local',
    });
    await gate.check('s1', {
      tool: 'shell',
      args: { command: 'cat ~/.ssh/id_rsa' },
      actor: 'local',
    });
    await gate.check('s1', { tool: 'shell', args: { command: 'Get-ChildItem' }, actor: 'local' });
    // shell is not on the allow list here, so the harmless call asks too: 3 in all.
    expect(prompts.length).toBe(3);
  });

  it('asks before destructive shell commands', async () => {
    let asked = false;
    const gate = new Gate({
      allow: ['shell'],
      approver: () => {
        asked = true;
        return true;
      },
    });
    await gate.check('s1', {
      tool: 'shell',
      args: { command: 'Remove-Item -Recurse C:\\stuff' },
      actor: 'local',
    });
    expect(asked).toBe(true);
  });

  it('denies when the approver itself throws', async () => {
    const gate = new Gate({
      allow: ['read'],
      approver: () => {
        throw new Error('channel died');
      },
    });
    const d = await gate.check('s1', { tool: 'shell', args: { command: 'dir' }, actor: 'local' });
    expect(d.verdict).toBe('deny');
  });

  it('keeps an audit trail without recording arguments', async () => {
    const gate = new Gate({ allow: ['shell'], approver: deny });
    await gate.check('s1', {
      tool: 'shell',
      args: { command: 'curl -d password=hunter2' },
      actor: 'local',
    });
    const trail = gate.auditTrail();
    expect(trail).toHaveLength(1);
    expect(JSON.stringify(trail)).not.toContain('hunter2');
  });
});

describe('lexicalNormalize', () => {
  it('collapses separators, case, dots and dotdots', () => {
    expect(lexicalNormalize('C:/Users/Nicoi/.ssh/../.ssh/')).toBe('c:\\users\\nicoi\\.ssh');
    expect(lexicalNormalize('C:\\Users\\nicoi\\.ssh')).toBe('c:\\users\\nicoi\\.ssh');
    expect(lexicalNormalize('.\\.ssh\\id_rsa')).toBe('.ssh\\id_rsa');
  });

  it('denies protected paths through .. evasion', async () => {
    const gate = new Gate({
      allow: ['write'],
      protectedPaths: ['C:\\Users\\nicoi\\.ssh'],
      approver: () => true,
    });
    const d = await gate.check('s1', {
      tool: 'write',
      args: { path: 'C:/Users/nicoi/.ssh/../.ssh/authorized_keys', content: 'x' },
      actor: 'local',
    });
    expect(d.verdict).toBe('deny');
  });
});

describe('Gate: Spanish payment and credential wording', () => {
  const asks = async (args: Record<string, unknown>) => {
    let asked = false;
    const gate = new Gate({
      allow: ['browser'],
      allowActions: ['browser:click'],
      approver: () => {
        asked = true;
        return false;
      },
    });
    await gate.check('s', { tool: 'browser', args, actor: 'asistenta' });
    return asked;
  };

  it.each([
    'Pagar ahora',
    'Finalizar compra',
    'Realizar pedido',
    'Confirmar pedido',
    'Añadir tarjeta de crédito',
    'Pagar con TARJETA',
    'Hacer una transferencia',
    'PÁGAR',
    'suscribirse',
    'Bizum',
  ])('asks for %s', async (text) => {
    expect(await asks({ action: 'click', selector: `text=${text}` })).toBe(true);
  });

  it.each(['Ver menú', 'Siguiente', 'Madrid', 'Buscar trenes', 'abrir'])(
    'does not mistake %s for money',
    async (text) => {
      expect(await asks({ action: 'click', selector: `text=${text}` })).toBe(false);
    },
  );

  it('does not match inside longer words', async () => {
    expect(await asks({ action: 'click', selector: 'text=Pagaré' })).toBe(false);
    expect(await asks({ action: 'click', selector: 'text=cargoso' })).toBe(false);
  });

  it('English payment words still ask', async () => {
    expect(await asks({ action: 'click', selector: 'text=Checkout' })).toBe(true);
  });
});

describe('isEffectText', () => {
  it.each(['Enviar', 'Publicar', 'Eliminar cuenta', 'Reservar mesa', 'Delete', 'CONFIRMAR'])(
    'flags %s',
    (t) => expect(isEffectText(t)).toBe(true),
  );
  it.each(['Ver más', 'Aceptar cookies', 'Siguiente', 'Sentido'])('ignores %s', (t) =>
    expect(isEffectText(t)).toBe(false),
  );
});

describe('checkout in the gate', () => {
  it('filling the buyer form by selector asks nothing', async () => {
    let asked = 0;
    const gate = new Gate({
      fullControl: true,
      allowPayments: true,
      allowUntilPayment: true,
      stageOf: checkoutStageOf,
      approver: async () => {
        asked++;
        return true;
      },
    });
    await gate.check('s', {
      tool: 'checkout',
      args: { action: 'fill_passenger', selectors: { document: '#dni' } },
      actor: 'u',
    });
    expect(asked).toBe(0);
  });

  it('an allow rule for checkout does not skip the confirm stage', async () => {
    let asked = 0;
    const gate = new Gate({
      allow: ['checkout'],
      allowUntilPayment: true,
      stageOf: checkoutStageOf,
      approver: async () => {
        asked++;
        return true;
      },
    } as never);
    await gate.check('s', { tool: 'checkout', args: { action: 'confirm', item: 'x' }, actor: 'u' });
    expect(asked).toBe(1);
  });
});
