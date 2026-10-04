import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { formatApprovalQuestion } from '../src/approval-text.js';
import { describeTarget, pageSummary } from '../src/browser/target.js';
import { BROWSER_FREE_ACTIONS, Gate, isPaymentText } from '../src/permissions.js';

// The Gate is built the way gateFor builds it, with the real free-action list.
const makeGate = (log: string[], opts: { fullControl?: boolean } = {}) =>
  new Gate({
    allow: ['read', 'fetch', 'done', 'memory'],
    allowActions: ['computer:screenshot', 'computer:move', ...BROWSER_FREE_ACTIONS],
    fullControl: opts.fullControl ?? false,
    approver: (call, reason) => {
      log.push(`${call.tool}:${String(call.args.action)} (${reason})`);
      return false;
    },
  });

const call = (args: Record<string, unknown>) => ({
  tool: 'browser',
  args,
  actor: 'asistenta',
});

describe('browser without prompts, money and credentials first', () => {
  it('navigating and operating a page never asks', async () => {
    const log: string[] = [];
    const gate = makeGate(log);
    for (const a of [
      { action: 'open', url: 'https://www.ubereats.com/es' },
      { action: 'open', url: 'https://glovoapp.com' },
      { action: 'snapshot' },
      { action: 'click', selector: '#btn-24', _target: 'button | Ver menú' },
      { action: 'fill', selector: '#city', _target: 'input | Ciudad', text: 'Madrid' },
      { action: 'press', selector: '#city', key: 'Enter', _target: 'input | Ciudad' },
    ]) {
      expect((await gate.check('s', call(a))).verdict).toBe('allow');
    }
    expect(log).toEqual([]);
  });

  it('exec_js is not free', async () => {
    const log: string[] = [];
    const d = await makeGate(log).check('s', call({ action: 'exec_js', code: 'return 1' }));
    expect(log).toHaveLength(1);
    expect(d.verdict).toBe('deny');
  });

  it.each([
    [
      'payment button',
      { action: 'click', selector: '#btn-23', _target: 'button | Realizar pedido' },
    ],
    ['pay icon', { action: 'click', selector: '#i', _target: 'button | aria Pagar con tarjeta' }],
    ['checkout url', { action: 'open', url: 'https://shop.example/checkout' }],
    [
      'password field',
      { action: 'fill', selector: '#p', _target: 'input | password | Contraseña', text: 'x' },
    ],
    [
      'card number field',
      { action: 'fill', selector: '#n', _target: 'input | cc-number', text: '4' },
    ],
    [
      'one-time code',
      { action: 'fill', selector: '#c', _target: 'input | one-time-code', text: '1' },
    ],
    ['password by selector', { action: 'fill', selector: 'input[type=password]', text: 'x' }],
    ['send element', { action: 'click', selector: '#s', _target: 'button | Enviar mensaje' }],
    ['delete element', { action: 'click', selector: '#d', _target: 'button | Eliminar cuenta' }],
    ['book element', { action: 'click', selector: '#r', _target: 'button | Reservar mesa' }],
    ['unreadable target', { action: 'click', selector: '#x', _target: '[destino ilegible]' }],
  ])('still asks: %s', async (_n, args) => {
    const log: string[] = [];
    await makeGate(log).check('s', call(args));
    expect(log).toHaveLength(1);
  });

  it('a standing "siempre/sesión" scope cannot cover money or credentials', async () => {
    const log: string[] = [];
    const gate = makeGate(log);
    gate.setScope('s', 'browser', 'always');
    await gate.check('s', call({ action: 'click', selector: '#b', _target: 'button | Pagar' }));
    await gate.check('s', call({ action: 'fill', selector: '#p', _target: 'input | password' }));
    expect(log).toHaveLength(2);
  });

  it('full control does not open payments or password fields either', async () => {
    const log: string[] = [];
    const gate = makeGate(log, { fullControl: true });
    await gate.check(
      's',
      call({ action: 'click', selector: '#b', _target: 'button | Pagar ahora' }),
    );
    await gate.check('s', call({ action: 'fill', selector: '#p', _target: 'input | password' }));
    expect(log).toHaveLength(2);
  });

  it('with no approver (unattended) money is denied, not run', async () => {
    const gate = new Gate({ allow: [], allowActions: BROWSER_FREE_ACTIONS });
    const d = await gate.check(
      's',
      call({ action: 'click', _target: 'button | Finalizar compra' }),
    );
    expect(d.verdict).toBe('deny');
  });
});

describe('approval text for a payment', () => {
  const PAGE = `<div>Hamburguesa clásica 9,90 €</div><div>Envío 1,50 €</div>
<div>Total 11,40 €</div><div>Entrega en: Calle Alcalá 10, Madrid</div><div>Gracias por elegirnos</div>
<button id="pay">Realizar pedido</button><button id="more">Ver más</button>`;
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser.close();
  });
  beforeEach(async () => {
    page = await browser.newPage();
    await page.setContent(PAGE);
  });

  it('shows the amounts and the address from the page itself', async () => {
    const target = await describeTarget(page, '#pay');
    expect(isPaymentText(target)).toBe(true);
    const summary = await pageSummary(page);
    const q = formatApprovalQuestion(
      {
        tool: 'browser',
        args: { action: 'click', _target: `${target}\nRESUMEN DE LA PÁGINA:\n${summary}` },
        actor: 'a',
      },
      'touches money or credentials',
    );
    expect(q).toContain('Realizar pedido');
    expect(q).toContain('Total 11,40 €');
    expect(q).toContain('Calle Alcalá 10');
    expect(q).not.toContain('Gracias por elegirnos');
  });

  it('does not read the page for an ordinary button', async () => {
    expect(isPaymentText(await describeTarget(page, '#more'))).toBe(false);
  });

  it('falls back to the plain question for other tools', () => {
    expect(
      formatApprovalQuestion({ tool: 'shell', args: {}, actor: 'a' }, 'runs a shell command'),
    ).toBe('¿Permito shell?\nruns a shell command');
  });
});
