import { describe, expect, it } from 'vitest';
import { renderPlaybook, validatePlaybook } from '../src/gestor/playbooks.js';
import * as demo from '../src/teach-demo.js';

// F11 paso 2 (puro, sin navegador): demostración grabada → playbook del gestor
// (selectores que funcionaron + NOMBRES de claves del almacén). Nunca valores.
type Mod = typeof demo;
const m = demo as Partial<Mod>;
const ON = { PA_TEACH_DEMO: '1' };
const PASS = 'Hunter2-super!';
const NOW = new Date('2026-10-30T20:00:00Z');

const events: demo.DemoEvent[] = [
  { type: 'navigate', url: 'https://www.tienda.example.com/login' },
  { type: 'input', target: { name: 'email', tag: 'input' }, value: 'nico@example.com' },
  { type: 'input', target: { id: 'pwd', inputType: 'password' }, value: PASS },
  { type: 'click', target: { testId: 'entrar' } },
  { type: 'navigate', url: 'https://tienda.example.com/buscar' },
  { type: 'input', target: { ariaLabel: 'Buscar', tag: 'input' }, value: 'café' },
  { type: 'submit', target: { role: 'button', text: 'Buscar' } },
];

function recorded(evs = events): demo.DemoPlaybook {
  const r = demo.recordDemo(evs, { env: ON });
  if (!r.ok) throw new Error(r.reason);
  return { steps: r.steps, params: r.params };
}

describe('F11 paso 2: demostración → playbook del gestor', () => {
  it('apagado por defecto: sin PA_TEACH_DEMO=1 no convierte nada', () => {
    expect(typeof m.demoToPlaybook).toBe('function');
    const r = m.demoToPlaybook?.(recorded(), { env: {}, now: NOW });
    expect(r).toEqual({ ok: false, reason: m.TEACH_DEMO_OFF });
  });

  it('selectores y nombres de parámetro, dominio canónico; ni valores de ejemplo ni secretos', () => {
    const r = m.demoToPlaybook?.(recorded(), { env: ON, now: NOW });
    expect(r?.ok).toBe(true);
    if (!r?.ok) return;
    const pb = r.playbook;
    expect(pb.domain).toBe('tienda.example.com');
    expect(pb.updatedAt).toBe(NOW.toISOString());
    expect(pb.selectores.length).toBeGreaterThan(0);
    expect(pb.selectores.some((l) => l.includes('«email»'))).toBe(true);
    expect(pb.login.some((l) => l.includes('vault:tienda.example.com:'))).toBe(true);
    const text = renderPlaybook(pb);
    for (const v of [PASS, 'nico@example.com', 'café']) expect(text).not.toContain(v);
    expect(validatePlaybook(pb)).toBeNull();
  });

  it('fusiona con un playbook existente sin duplicar líneas y conservando las suyas', () => {
    const first = m.demoToPlaybook?.(recorded(), { env: ON, now: NOW });
    if (!first?.ok) throw new Error('no ok');
    const existing = { ...first.playbook, quirks: ['el login tarda 3 s'] };
    const again = m.demoToPlaybook?.(recorded(), { env: ON, now: NOW, existing });
    if (!again?.ok) throw new Error('no ok');
    expect(again.playbook.selectores).toEqual(first.playbook.selectores);
    expect(again.playbook.login).toEqual(first.playbook.login);
    expect(again.playbook.quirks).toEqual(['el login tarda 3 s']);
  });

  it('rechaza una demostración que cambia de dominio o un existente de otro dominio', () => {
    const two = [...events, { type: 'navigate', url: 'https://otro.example.org/' } as const];
    const r = m.demoToPlaybook?.(recorded(two), { env: ON, now: NOW });
    expect(r?.ok).toBe(false);
    const first = m.demoToPlaybook?.(recorded(), { env: ON, now: NOW });
    if (!first?.ok) throw new Error('no ok');
    const other = { ...first.playbook, domain: 'otro.example.org' };
    expect(m.demoToPlaybook?.(recorded(), { env: ON, now: NOW, existing: other })?.ok).toBe(false);
  });

  it('nunca guarda un playbook que no pasaría validatePlaybook (demasiadas notas)', () => {
    const many: demo.DemoEvent[] = [{ type: 'navigate', url: 'https://tienda.example.com/' }];
    for (let i = 0; i < 25; i++) many.push({ type: 'click', target: { testId: `b${i}` } });
    const r = m.demoToPlaybook?.(recorded(many), { env: ON, now: NOW });
    expect(r?.ok).toBe(false);
    if (r && !r.ok) expect(r.reason).toMatch(/selectores/);
  });
});
