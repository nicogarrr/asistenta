import { describe, expect, it } from 'vitest';
import { Gate, pageSaysMoney, splitTarget } from '../src/permissions.js';

const asks = async (args: Record<string, unknown>, tool = 'browser') => {
  let asked = false;
  const gate = new Gate({
    allow: ['done', 'memory', 'fetch'],
    allowActions: ['browser:click', 'browser:press', 'browser:fill'],
    approver: () => {
      asked = true;
      return false;
    },
  });
  await gate.check('s', { tool, args, actor: 'asistenta' });
  return asked;
};

const click = (_target: string) => asks({ action: 'click', selector: '#b', _target });

describe('prices alone do not ask', () => {
  it('a shop page with visible prices but no payment URL lets clicks through', async () => {
    expect(
      await click('button | Anadir a la cesta @@ https://glovo.com/es/menu | Menu 4,50 €'),
    ).toBe(false);
    expect(
      await click('button | Ver menu @@ https://ubereats.com/es/store/x | Total 12,00 €'),
    ).toBe(false);
  });
});

describe('payment buttons in English and generic wording ask', () => {
  it.each([
    'button | Place order',
    'button | Place your order',
    'button | Complete order',
    'button | Order now',
    'button | Finish',
    'a | Continuar @@ https://shop.es/pasarela',
    'button | Aceptar y continuar @@ https://shop.es/checkout/step3',
    'button | Next @@ https://shop.es/cart | Tu cesta',
  ])('asks: %s', async (t) => expect(await click(t)).toBe(true));

  it('Enter on a page with a payment signal asks', async () => {
    expect(
      await asks({
        action: 'press',
        selector: '#f',
        _target: 'input | text | email @@ https://shop.es/checkout',
      }),
    ).toBe(true);
  });

  it('a normal form with a Submit button does not ask (direct send)', async () => {
    expect(
      await click(
        'button | Submit order | submit @@ /post | https://httpbin.org/forms/post | Form',
      ),
    ).toBe(false);
    expect(
      await asks({
        action: 'press',
        selector: '#f',
        _target: 'input | text | custname @@ https://httpbin.org/forms/post',
      }),
    ).toBe(false);
  });

  it('a /post/ or /book/ URL alone does not make a harmless link ask', async () => {
    expect(await click('a | Leer más @@ https://blog.es/post/12 | Blog')).toBe(false);
    expect(await click('a | Ver @@ https://site.es/book/9 | Libro')).toBe(false);
  });
});

describe('Spanish vocabulary stays inside web tools', () => {
  it.each([
    ['done', { text: 'te avisé del cargo' }],
    ['memory', { text: 'pedir cita médica el jueves' }],
    ['fetch', { url: 'https://www.bancodeespana.es/saldo' }],
  ])('%s is not asked', async (tool, args) => {
    expect(await asks(args, tool)).toBe(false);
  });
  it('a card number still asks in any tool', async () => {
    expect(await asks({ text: '4111 1111 1111 1111' }, 'done')).toBe(true);
  });
});

describe('credential fields', () => {
  it.each(['pin', 'clave', 'dni', 'iban'])('field "%s" asks', async (w) => {
    expect(
      await asks({
        action: 'fill',
        selector: '#x',
        _target: `input | text | ${w} @@ https://a.es`,
      }),
    ).toBe(true);
  });
});

describe('helpers', () => {
  it('splits element words from places', () => {
    expect(splitTarget('button | Ok @@ /a | https://x.es')).toEqual({
      element: 'button | Ok',
      places: '/a | https://x.es',
    });
    expect(pageSaysMoney('https://x.es/checkout')).toBe(true);
    expect(pageSaysMoney('https://x.es/blog/post/1')).toBe(false);
  });
});
