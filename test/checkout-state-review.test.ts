import { describe, expect, it, vi } from 'vitest';
import { type CheckoutPage, createCheckoutTool } from '../src/tools/checkout.js';

// SYNTHETIC page text. The confirmation must show the user's original request next to
// the place lines the PROGRAM read from the page, and must never continue without the
// human's yes. It does not decide whether the selection is right.
function page(body: string): CheckoutPage {
  return {
    open: async (url) => ({ url, title: 't' }),
    label: async () => '',
    fill: async () => {},
    click: async () => {},
    press: async () => {},
    text: async () => body,
    url: async () => 'https://shop.example/cart',
    show: async () => true,
  };
}

const run = async (body: string, goal: string | undefined, answer: boolean) => {
  const asked: string[] = [];
  const requireApproval = vi.fn(async (_a: string, summary: string) => {
    asked.push(summary);
    return answer;
  });
  const shown = vi.fn();
  const p = page(body);
  p.show = async () => {
    shown();
    return true;
  };
  const tool = createCheckoutTool({ page: p, requireApproval, goal: () => goal });
  const r = await tool.execute(
    'id',
    { action: 'confirm', item: 'pizza', price: '25,00' } as never,
    undefined,
    undefined,
  );
  return { asked, shown, text: JSON.stringify(r.content) };
};

describe('confirmation shows request vs page place, and waits for the human (SYNTHETIC)', () => {
  it('Mollet on the page vs Gijón requested: both shown, nothing continues on "no"', async () => {
    const body =
      'Mi tienda\nMOLLET 1 - Plaza Mayor 4 local 9, 08100 Mollet (Barcelona)\nTotal 25,00 EUR';
    const r = await run(body, 'Quiero recoger una pizza en una tienda de Gijón', false);
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]).toContain('Gijón');
    expect(r.asked[0]).toContain('Mollet');
    expect(r.asked[0]).toContain('NO ha verificado');
    expect(r.shown).not.toHaveBeenCalled();
    expect(r.text).toMatch(/No he comprado nada/);
  });

  it('consistent page: same display, and yes proceeds as before (control)', async () => {
    const body = 'Mi tienda\nGIJON PLAZA - Plaza Mayor 2, 33201 Gijón (Asturias)\nTotal 25,00 EUR';
    const r = await run(body, 'Quiero recoger una pizza en una tienda de Gijón', true);
    expect(r.asked[0]).toContain('Gijón (Asturias)');
    expect(r.shown).toHaveBeenCalled();
  });

  it('no goal available and no place line: says so explicitly, never invents', async () => {
    const r = await run('Total 25,00 EUR', undefined, false);
    expect(r.asked[0]).toContain('no disponible');
    expect(r.asked[0]).toContain('no verificado');
  });
});
