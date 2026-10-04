/**
 * The purchase policy, end to end: what the gate lets through on the way to a payment
 * screen, what it refuses, and the two facts the whole design rests on - the charge is
 * never automated, and the buyer's document never reaches the model's context.
 *
 * Every test here uses a fake page, which is the only way to assert the first of those:
 * "confirm clicked nothing" cannot be checked against a real browser without charging
 * somebody's card.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  fillPassengerForm,
  hasPassenger,
  loadPassenger,
  missingPassengerFields,
  type Passenger,
  passengerCompleteness,
  savePassengerField,
  type VaultReader,
} from '../src/commerce/profile.js';
import { Gate } from '../src/permissions.js';
import {
  CHECKOUT_STAGES,
  type CheckoutPage,
  checkoutStageOf,
  createCheckoutTool,
  extractPrices,
  looksLikePaymentSubmission,
} from '../src/tools/checkout.js';

const DNI = '12345678Z';
const BUYER: Passenger = {
  fullName: 'Marta Ruiz',
  document: DNI,
  email: 'marta@example.com',
  phone: '600112233',
};

function vaultOf(values: Record<string, string>): VaultReader & { writes: string[] } {
  const map: Record<string, string> = { ...values };
  const writes: string[] = [];
  return {
    writes,
    get: async (key) => map[key],
    set: async (key, value) => {
      writes.push(key);
      map[key] = value;
    },
  };
}

/** A page that records everything, so a test can assert what was and was not touched. */
class FakePage implements CheckoutPage {
  readonly fills: Array<{ selector: string; value: string }> = [];
  readonly clicks: string[] = [];
  readonly presses: string[] = [];
  readonly labels = new Map<string, string>();
  body = '';
  opened: string[] = [];
  shown = false;

  async open(url: string) {
    this.opened.push(url);
    return { url, title: 'Fake' };
  }

  async label(selector: string) {
    return this.labels.get(selector) ?? '';
  }

  async fill(selector: string, value: string) {
    this.fills.push({ selector, value });
  }

  async click(selector: string) {
    this.clicks.push(selector);
  }

  async press(selector: string, key: string) {
    this.presses.push(`${selector}:${key}`);
  }

  async text() {
    return this.body;
  }

  async url() {
    return this.opened[this.opened.length - 1] ?? 'about:blank';
  }

  info = new Map<string, Record<string, unknown>>();
  async inspect(selector: string) {
    const i = this.info.get(selector) ?? {};
    return {
      label: this.labels.get(selector) ?? '',
      button: false,
      formSubmit: '',
      where: `${await this.url()} | Fake`,
      ...i,
    } as never;
  }

  async show() {
    this.shown = true;
    return true;
  }
}

const SELECTORS = {
  fullName: '#nombre',
  document: '#dni',
  email: '#email',
  phone: '#tel',
};

function toolWith(
  page: FakePage,
  passenger: Passenger | null,
  requireApproval: (action: string, summary: string) => Promise<boolean>,
) {
  return createCheckoutTool({
    page,
    loadPassenger: async () => passenger,
    requireApproval,
  });
}

async function call(tool: ReturnType<typeof toolWith>, args: Record<string, unknown>) {
  return tool.execute('id', args as never, undefined, undefined);
}

function textOf(result: Awaited<ReturnType<typeof call>>): string {
  const first = result.content[0];
  return first && first.type === 'text' ? first.text : '';
}

// ---------------------------------------------------------------------------
// Gate: the stage policy
// ---------------------------------------------------------------------------

describe('gate, autonomous up to the last click', () => {
  const gateWith = (asked: () => void, extra: Record<string, unknown> = {}) =>
    new Gate({
      allowUntilPayment: true,
      stageOf: checkoutStageOf,
      grantWindowMs: 0,
      approver: () => {
        asked();
        return true;
      },
      ...extra,
    });

  it('lets browse and fill through without asking', async () => {
    let asked = 0;
    const gate = gateWith(() => asked++);

    const browse = await gate.check('s1', {
      tool: 'checkout',
      args: { action: 'select', selector: '#btn-continuar', item: 'tren Madrid-Barcelona' },
      actor: 'u',
    });
    const fill = await gate.check('s1', {
      tool: 'checkout',
      args: { action: 'fill_passenger', selectors: { fullName: '#nombre' } },
      actor: 'u',
    });

    expect(browse.verdict).toBe('allow');
    expect(fill.verdict).toBe('allow');
    expect(asked, 'preguntar por navegar o rellenar es el fallo que se quiere quitar').toBe(0);
  });

  it('asks for confirm every single time, even the second identical call', async () => {
    let asked = 0;
    const gate = gateWith(() => asked++);
    const call = {
      tool: 'checkout',
      args: { action: 'confirm', item: 'tren Madrid-Barcelona', price: '45,20' },
      actor: 'u',
    };

    const first = await gate.check('s1', call);
    const second = await gate.check('s1', call);
    const other = await gate.check('s1', {
      tool: 'checkout',
      args: { action: 'confirm', item: 'tren Madrid-Barcelona', price: '52,00' },
      actor: 'u',
    });

    // Not once: three calls, three questions. A "yes" to one amount is not a "yes" to
    // the next purchase of the same thing, and it is not a standing grant either.
    expect(asked).toBe(3);
    expect(first.reason).toBe('approved by u');
    expect(second.verdict).toBe('allow');
    expect(other.verdict).toBe('allow');
  });

  it('does not let confirm ride on full control, allowPayments or a scope', async () => {
    let asked = 0;
    const gate = gateWith(() => asked++, {
      fullControl: true,
      allowPayments: true,
    });
    gate.setScope('s1', 'checkout', 'always');
    const charge = {
      tool: 'checkout',
      args: { action: 'confirm', item: 'vuelo', price: '120,00' },
      actor: 'u',
    };

    // Full control plus allowPayments plus an "always" grant on the tool, and it still
    // asks. Those three flags are the only way this gate could be talked into paying,
    // so all three are on at once here.
    expect((await gate.check('s1', charge)).reason).toBe('approved by u');
    expect((await gate.check('s1', charge)).reason).toBe('approved by u');
    expect(asked).toBe(2);
  });

  it('does not let confirm ride on the grant window either', async () => {
    let asked = 0;
    const gate = gateWith(() => asked++);
    await gate.check('s1', {
      tool: 'computer',
      args: { action: 'click', x: 1, y: 1 },
      actor: 'u',
    });
    await gate.check('s1', {
      tool: 'checkout',
      args: { action: 'confirm', item: 'vuelo', price: '120,00' },
      actor: 'u',
    });
    expect(asked).toBe(2);
  });

  it('still asks when the arguments carry money, whatever the stage claims', async () => {
    // A stage label is a claim, not evidence. A card number in the arguments re-arms
    // the payment rule even on a `browse` stage, which is the difference between this
    // and a heuristic that trusts the label.
    let asked = 0;
    const gate = gateWith(() => asked++);

    const card = await gate.check('s1', {
      tool: 'checkout',
      args: { action: 'select', selector: '#x', text: '4111 1111 1111 1111' },
      actor: 'u',
    });
    const credential = await gate.check('s1', {
      tool: 'checkout',
      args: { action: 'search', url: 'file:///C:/Users/nicoi/.ssh/id_rsa' },
      actor: 'u',
    });

    expect(card.reason).toBe('approved by u');
    expect(credential.reason).toBe('approved by u');
    expect(asked).toBe(2);
  });

  it('sees a card number that sits next to another argument', async () => {
    // A regression guard on the rule the whole preflight exemption leans on. Stripping
    // every space out of the arguments also deleted the word boundaries the pattern
    // needs, so the digits ended up welded to the argument before them and this call
    // passed as an ordinary browse step.
    let asked = 0;
    const gate = gateWith(() => asked++);
    const d = await gate.check('s1', {
      tool: 'checkout',
      args: { action: 'select', selector: '#x', text: '4111 1111 1111 1111' },
      actor: 'u',
    });
    expect(d.reason).toBe('approved by u');
    expect(asked).toBe(1);
  });

  it('does not let a browse stage walk past a destructive shell command', async () => {
    let asked = 0;
    const gate = gateWith(() => asked++);
    await gate.check('s1', {
      tool: 'shell',
      args: { command: 'Remove-Item -Recurse C:\\cosas' },
      actor: 'u',
    });
    expect(asked).toBe(1);
  });

  it('changes nothing when the flag is off', async () => {
    let asked = 0;
    const gate = new Gate({
      grantWindowMs: 0,
      approver: () => {
        asked++;
        return true;
      },
    });
    const browse = await gate.check('s1', {
      tool: 'checkout',
      args: { action: 'select', selector: '#btn' },
      actor: 'u',
    });
    expect(browse.reason).toBe('approved by u');
    expect(asked).toBe(1);
  });

  it('falls back to asking for an action the stage table does not know', async () => {
    let asked = 0;
    const gate = gateWith(() => asked++);
    expect(
      checkoutStageOf({ tool: 'checkout', args: { action: 'inventado' } }),
      'unknown action must not be answered by omission',
    ).toBeUndefined();
    await gate.check('s1', { tool: 'checkout', args: { action: 'inventado' }, actor: 'u' });
    expect(asked).toBe(1);
  });

  it('maps every action to a stage in one table', () => {
    expect(CHECKOUT_STAGES).toEqual({
      search: 'browse',
      select: 'browse',
      fill_passenger: 'fill',
      status: 'browse',
      confirm: 'confirm',
    });
  });
});

// ---------------------------------------------------------------------------
// Profile: the vault, and what the model is allowed to hear
// ---------------------------------------------------------------------------

describe('loadPassenger', () => {
  it('returns null for an empty vault', async () => {
    expect(await loadPassenger(vaultOf({}))).toBeNull();
    expect(await hasPassenger(vaultOf({}))).toBe(false);
  });

  it('returns null when every stored value is blank', async () => {
    const vault = vaultOf({
      'travel:fullName': '   ',
      'travel:document': '',
      'travel:email': ' ',
      'travel:phone': '',
    });
    expect(await loadPassenger(vault)).toBeNull();
  });

  it('reads the four travel keys and reports what is missing', async () => {
    const vault = vaultOf({
      'travel:fullName': 'Marta Ruiz',
      'travel:document': DNI,
      'travel:email': 'marta@example.com',
    });
    const passenger = await loadPassenger(vault);
    expect(passenger).toEqual({
      fullName: 'Marta Ruiz',
      document: DNI,
      email: 'marta@example.com',
      phone: '',
    });
    expect(missingPassengerFields(passenger)).toEqual(['phone']);
    expect(await hasPassenger(vault)).toBe(false);
  });

  it('is complete only when all four are there', async () => {
    const full = vaultOf({
      'travel:fullName': 'Marta Ruiz',
      'travel:document': DNI,
      'travel:email': 'marta@example.com',
      'travel:phone': '600112233',
    });
    expect(await hasPassenger(full)).toBe(true);
    const state = passengerCompleteness(await loadPassenger(full));
    expect(state).toEqual({ known: true, complete: true, missing: [] });
  });

  it('saves one field without writing the others', async () => {
    const vault = vaultOf({});
    await savePassengerField('document', ` ${DNI} `, vault);
    expect(vault.writes).toEqual(['travel:document']);
    expect((await loadPassenger(vault))?.document).toBe(DNI);
  });

  it('refuses to store a blank value', async () => {
    await expect(savePassengerField('phone', '   ', vaultOf({}))).rejects.toThrow(/viene vacío/);
  });
});

function fakeFiller(): { fill: ReturnType<typeof vi.fn<(s: string, v: string) => Promise<void>>> } {
  return { fill: vi.fn<(s: string, v: string) => Promise<void>>(async () => {}) };
}

describe('fillPassengerForm', () => {
  it('writes the values and returns names only', async () => {
    const filler = fakeFiller();
    const result = await fillPassengerForm(filler, BUYER, SELECTORS);
    expect(result).toEqual({
      filled: ['fullName', 'document', 'email', 'phone'],
      unmatched: [],
      failed: [],
    });
    // The values really did reach the form.
    expect(filler.fill.mock.calls.map((c) => c[1])).toEqual([
      BUYER.fullName,
      DNI,
      BUYER.email,
      BUYER.phone,
    ]);
  });

  it('cannot express a value in its result', async () => {
    const filler = fakeFiller();
    const result = await fillPassengerForm(filler, BUYER, SELECTORS);
    // The type has nowhere to put a value; this asserts it on the serialised form too,
    // because `details` goes to the provider and a leak there is not recoverable.
    expect(JSON.stringify(result)).not.toContain(DNI);
    expect(JSON.stringify(result)).not.toContain(BUYER.email);
  });

  it('skips a field with no selector and one with no stored value', async () => {
    const filler = fakeFiller();
    const result = await fillPassengerForm(filler, BUYER, { fullName: '#nombre', email: '#email' });
    expect(result.filled).toEqual(['fullName', 'email']);
    expect(result.unmatched).toEqual(['document', 'phone']);
  });

  it('reports a field the site refused, by name and reason', async () => {
    const filler = {
      fill: async (selector: string) => {
        if (selector === '#dni') throw new Error('campo bloqueado');
      },
    };
    const result = await fillPassengerForm(filler, BUYER, SELECTORS);
    expect(result.filled).toEqual(['fullName', 'email', 'phone']);
    expect(result.failed).toEqual([{ field: 'document', reason: 'campo bloqueado' }]);
  });
});

// ---------------------------------------------------------------------------
// The tool: what the model sees, and what it can press
// ---------------------------------------------------------------------------

describe('checkout tool', () => {
  it('never puts the document or the email in anything the model reads', async () => {
    const page = new FakePage();
    const tool = toolWith(page, BUYER, async () => true);

    const filled = await call(tool, { action: 'fill_passenger', selectors: SELECTORS });
    const status = await call(tool, { action: 'status' });

    // The values reached the page...
    expect(page.fills.map((f) => f.value)).toContain(DNI);
    // ...and nowhere the model can see them.
    for (const result of [filled, status]) {
      const payload = JSON.stringify(result);
      expect(payload, payload).not.toContain(DNI);
      expect(payload).not.toContain(BUYER.email);
      expect(payload).not.toContain(BUYER.phone);
    }
    expect(textOf(filled)).toContain('document');
    expect(textOf(status)).toContain('Tengo todos los datos de comprador');
  });

  it('says what it needs when the vault is empty, and fills nothing', async () => {
    const page = new FakePage();
    const tool = toolWith(page, null, async () => true);
    const result = await call(tool, { action: 'fill_passenger', selectors: SELECTORS });
    expect(page.fills).toHaveLength(0);
    expect(textOf(result)).toMatch(/Pídele al usuario/);
    expect(JSON.stringify(result)).not.toContain('vault:');
  });

  it('refuses to press a button that reads as a charge', async () => {
    for (const label of [
      'Pagar',
      'Pagar ahora',
      'Pagar y continuar',
      'Realizar el pago',
      'Confirmar el pago',
      'Finalizar la compra',
      'Pay now',
      'Complete payment',
      'Place order',
      'Comprar',
      'Comprar ahora',
      'Realizar pedido',
      'Hacer pedido',
      'Finalizar pedido',
      'Confirmar compra',
      'Order now',
      'Tramitar pedido',
      'Pedir ahora',
      'Reservar',
      'Contratar',
      'Suscribirse',
      'Pay',
      'Buy',
      'Pago con tarjeta',
    ]) {
      const page = new FakePage();
      page.labels.set('#btn', label);
      const tool = toolWith(page, BUYER, async () => true);
      await expect(call(tool, { action: 'select', selector: '#btn' })).rejects.toThrow(/no pulso/);
      // The label is read before the click, not after: nothing was pressed.
      expect(page.clicks, label).toHaveLength(0);
    }
  });

  it('reads value, form submit and page for the charge check', async () => {
    const page = new FakePage();
    page.info.set('#s', { label: 'Pagar ahora', button: true });
    const tool = toolWith(page, BUYER, async () => true);
    await expect(call(tool, { action: 'select', selector: '#s' })).rejects.toThrow(/no pulso/);
    // A search box whose form submits with a charge button: Enter is a press too.
    page.info.set('#q', { label: 'Buscar', button: false, formSubmit: 'Comprar ahora' });
    await expect(call(tool, { action: 'search', query: 'x', selector: '#q' })).rejects.toThrow(
      /no/i,
    );
    expect(page.presses).toHaveLength(0);
    // On a payment page a button is refused whatever it says.
    await call(tool, { action: 'search', url: 'https://tienda.es/checkout/pago' });
    page.info.set('#ok', { label: 'Aceptar', button: true });
    await expect(call(tool, { action: 'select', selector: '#ok' })).rejects.toThrow(/no pulso/);
  });

  it('shows the amount with the symbol the page uses', async () => {
    const page = new FakePage();
    page.body = 'Total 45,20 $';
    const seen: string[] = [];
    const tool = toolWith(page, BUYER, async (_a, summary) => {
      seen.push(summary);
      return true;
    });
    await call(tool, { action: 'confirm', item: 'tren', price: '45,20' });
    expect(seen[0]).toContain('45,20 $');
    expect(seen[0]).not.toContain('€');
  });

  it('lets it press the buttons that lead to the payment screen', async () => {
    for (const label of [
      'Continuar',
      'Continuar al pago',
      'Ir al paso de pago',
      'Siguiente',
      'Elegir este tren',
    ]) {
      const page = new FakePage();
      page.labels.set('#btn', label);
      const tool = toolWith(page, BUYER, async () => true);
      await call(tool, { action: 'select', selector: '#btn' });
      expect(page.clicks, label).toEqual(['#btn']);
    }
  });

  it('classifies labels the same way whoever asks', () => {
    expect(looksLikePaymentSubmission('Pagar 45,20 €')).toBe(true);
    expect(looksLikePaymentSubmission('Continuar al pago')).toBe(false);
    // One vocabulary with the gate: a payment-method choice is the person's to make.
    expect(looksLikePaymentSubmission('PayPal')).toBe(true);
    expect(looksLikePaymentSubmission('')).toBe(false);
  });

  it('confirm does nothing at all when the user says no', async () => {
    const page = new FakePage();
    page.body = 'Total 45,20 EUR';
    const requireApproval = vi.fn(async () => false);
    const tool = toolWith(page, BUYER, requireApproval);

    const result = await call(tool, { action: 'confirm', item: 'tren', price: '45,20' });

    expect(requireApproval).toHaveBeenCalledTimes(1);
    // Nothing on the page was touched and nothing was bought.
    expect(page.clicks).toHaveLength(0);
    expect(page.fills).toHaveLength(0);
    expect(page.shown).toBe(false);
    expect(textOf(result)).toMatch(/No he comprado nada/);

    const status = await call(tool, { action: 'status' });
    expect(textOf(status)).toMatch(/Compra sin confirmar/);
  });

  it('confirm takes no selector, so there is no pay button to point it at', async () => {
    const page = new FakePage();
    page.body = 'Total 45,20 EUR';
    const tool = toolWith(page, BUYER, async () => true);
    await expect(
      call(tool, { action: 'confirm', item: 'tren', selector: '#btn-pagar' }),
    ).rejects.toThrow(/no acepta selector/);
    expect(page.clicks).toHaveLength(0);
  });

  it('confirm asks with the product and the price before it asks anything', async () => {
    const page = new FakePage();
    page.body = 'Billete Madrid - Barcelona\nTotal 45,20 EUR';
    const seen: string[] = [];
    const tool = toolWith(page, BUYER, async (_action, summary) => {
      seen.push(summary);
      return true;
    });

    const result = await call(tool, {
      action: 'confirm',
      item: 'tren Madrid-Barcelona',
      price: '45,20',
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('tren Madrid-Barcelona');
    expect(seen[0]).toContain('45,20');
    expect(seen[0]).toMatch(/NO pulso el boton de pagar/);
    // And it still pressed nothing: the approval hands the browser over, it does not
    // finish the purchase.
    expect(page.clicks).toHaveLength(0);
    expect(page.fills).toHaveLength(0);
    expect(page.shown).toBe(true);
    expect(textOf(result)).toMatch(/no he pulsado ningun boton de pago/i);
  });

  it('confirm refuses to ask about a price it cannot read', async () => {
    const page = new FakePage();
    page.body = 'Elige tu tren';
    const requireApproval = vi.fn(async () => true);
    const tool = toolWith(page, BUYER, requireApproval);
    const result = await call(tool, { action: 'confirm', item: 'tren' });
    expect(requireApproval).not.toHaveBeenCalled();
    expect(textOf(result)).toMatch(/no conozco/);
  });

  it('confirm warns when the amount disagrees with the page', async () => {
    const page = new FakePage();
    page.body = 'Total 45,20 EUR';
    const seen: string[] = [];
    const tool = toolWith(page, BUYER, async (_a, summary) => {
      seen.push(summary);
      return true;
    });
    await call(tool, { action: 'confirm', item: 'tren', price: '40,00' });
    expect(seen[0]).toMatch(/la pagina muestra 45,20/);
  });

  it('a new url forgets the previous purchase, approval included', async () => {
    const page = new FakePage();
    const requireApproval = vi.fn(async () => true);
    const tool = toolWith(page, BUYER, requireApproval);

    await call(tool, { action: 'select', selector: '#tren', item: 'tren' });
    page.body = 'Total 45,20 EUR';
    await call(tool, { action: 'confirm', item: 'tren', price: '45,20' });
    const approved = await call(tool, { action: 'status' });
    expect(textOf(approved)).toMatch(/Compra confirmada/);

    await call(tool, { action: 'search', url: 'https://ejemplo.es/otra' });
    const fresh = await call(tool, { action: 'status' });
    expect(textOf(fresh)).toMatch(/Compra sin confirmar/);
    expect(textOf(fresh)).toMatch(/todavia no elegido/);
  });
});

describe('extractPrices', () => {
  it('finds prices in both orders and normalises the spacing', () => {
    expect(extractPrices('Total 45,20 € y antes 1.234,56 €')).toEqual(['45,20', '1.234,56']);
    expect(extractPrices('Precio: € 12,00')).toEqual(['12,00']);
    expect(extractPrices('sin precios aqui')).toEqual([]);
    expect(extractPrices('2026-10-03')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The whole flow, with the gate in the loop
// ---------------------------------------------------------------------------

describe('a purchase from search to the payment screen', () => {
  it('asks nothing until confirm, and stops there', async () => {
    let asked = 0;
    const askedFor: string[] = [];
    const gate = new Gate({
      // Full control on, because that is how this daemon runs, and allowPayments too:
      // the point of the test is that neither of them makes the charge automatic.
      fullControl: true,
      allowPayments: true,
      allowUntilPayment: true,
      stageOf: checkoutStageOf,
      approver: async (call) => {
        asked++;
        askedFor.push(`${call.tool}:${String(call.args.action)}`);
        return true;
      },
    });

    const page = new FakePage();
    page.labels.set('#buscar', 'Buscar');
    page.labels.set('#tren', 'Elegir este tren');
    page.labels.set('#pagar', 'Pagar');
    page.body = 'Total 45,20 EUR';
    const tool = toolWith(page, BUYER, async (action) => {
      asked++;
      askedFor.push(action);
      return true;
    });

    const run = async (args: Record<string, unknown>) => {
      const decision = await gate.check('s1', { tool: 'checkout', args, actor: 'u' });
      expect(decision.verdict, `bloqueado en ${String(args.action)}`).toBe('allow');
      return call(tool, args);
    };

    await run({ action: 'search', url: 'https://ejemplo.es/trenes' });
    await run({ action: 'search', query: 'Madrid Barcelona', selector: '#buscar' });
    await run({ action: 'select', selector: '#tren', item: 'tren Madrid-Barcelona' });
    await run({ action: 'fill_passenger', selectors: SELECTORS });
    await run({ action: 'status' });

    // Browsing, choosing, filling and asking where we are: five calls, zero questions.
    expect(askedFor).toEqual([]);
    expect(asked).toBe(0);

    // The last step is the only one that asks: once by the gate, once by the tool.
    await run({ action: 'confirm', item: 'tren Madrid-Barcelona', price: '45,20' });
    expect(asked).toBe(2);
    expect(askedFor).toEqual(['checkout:confirm', 'checkout:confirm']);

    // Browsing and choosing clicked what they had to. The pay button, which the page
    // was offering, was never pressed at any point in the flow.
    expect(page.clicks).toEqual(['#tren']);
    expect(page.labels.get('#pagar')).toBe('Pagar');
  });

  it('stops at confirm when the charge is refused, and the run can be retried', async () => {
    let asked = 0;
    const gate = new Gate({
      fullControl: true,
      allowPayments: true,
      allowUntilPayment: true,
      stageOf: checkoutStageOf,
      approver: () => {
        asked++;
        return false;
      },
    });
    const page = new FakePage();
    page.body = 'Total 45,20 EUR';
    const tool = toolWith(page, BUYER, async () => {
      asked++;
      return false;
    });

    const charge = { action: 'confirm', item: 'tren', price: '45,20' };
    // Two attempts, each one gated and each one confirmed. Both are refused, by the
    // gate and by the tool.
    for (const _attempt of [1, 2]) {
      const denied = await gate.check('s1', { tool: 'checkout', args: charge, actor: 'u' });
      expect(denied.verdict).toBe('deny');
      await call(tool, charge);
    }

    // A refusal is not remembered as consent, and a consent would not be remembered
    // either: four attempts at a charge, four questions, zero purchases.
    expect(asked).toBe(4);
    expect(page.clicks).toHaveLength(0);
  });
});
