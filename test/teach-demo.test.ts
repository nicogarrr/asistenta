import { describe, expect, it } from 'vitest';
import * as demo from '../src/teach-demo.js';

// F11 (núcleo puro): eventos simulados de una demostración → pasos → reproducción.
// Sin navegador real. Apagado por defecto (PA_TEACH_DEMO=1).
type Mod = typeof demo;
const m = demo as Partial<Mod>;
const ON = { PA_TEACH_DEMO: '1' };
const PASS = 'Hunter2-super!';

const events: demo.DemoEvent[] = [
  { type: 'navigate', url: 'https://user:pw@tienda.example.com/login' },
  { type: 'input', target: { name: 'email', tag: 'input' }, value: 'a' },
  { type: 'input', target: { name: 'email', tag: 'input' }, value: 'nico@example.com' },
  { type: 'input', target: { id: 'pwd', inputType: 'password' }, value: PASS },
  { type: 'click', target: { testId: 'entrar' } },
  { type: 'navigate', url: 'https://tienda.example.com/buscar' },
  { type: 'input', target: { ariaLabel: 'Buscar', tag: 'input' }, value: 'café' },
  // El mismo secreto escrito en un campo «normal» también se tapa.
  { type: 'input', target: { name: 'nota' }, value: PASS },
  { type: 'submit', target: { role: 'button', text: '  Buscar  ' } },
];

describe('F11 enseñar con demostración (núcleo)', () => {
  it('apagado por defecto: no graba ni reproduce sin PA_TEACH_DEMO=1', () => {
    expect(m.recordDemo?.(events, { env: {} })).toEqual({ ok: false, reason: m.TEACH_DEMO_OFF });
    expect(m.TEACH_DEMO_OFF).toMatch(/PA_TEACH_DEMO=1/);
    expect(() => m.replayDemo?.({ steps: [], params: {} }, {}, { env: {} })).toThrow(
      /PA_TEACH_DEMO=1/,
    );
  });

  it('genera pasos con selectores estables y parámetros', () => {
    const r = m.recordDemo?.(events, { env: ON });
    expect(r?.ok).toBe(true);
    if (!r?.ok) return;
    expect(r.steps).toEqual([
      { action: 'goto', url: 'https://tienda.example.com/login' },
      { action: 'fill', selector: 'input[name="email"]', param: 'email' },
      { action: 'fill', selector: '#pwd', secret: '{{vault:tienda.example.com:pwd}}' },
      { action: 'click', selector: '[data-testid="entrar"]' },
      { action: 'goto', url: 'https://tienda.example.com/buscar' },
      { action: 'fill', selector: 'input[aria-label="Buscar"]', param: 'buscar' },
      { action: 'fill', selector: '[name="nota"]', secret: '{{vault:tienda.example.com:nota}}' },
      { action: 'submit', selector: 'button >> text="Buscar"' },
    ]);
    expect(r.params).toEqual({ email: 'nico@example.com', buscar: 'café' });
  });

  it('nunca guarda una contraseña, tarjeta o código (ni repetida en otro campo)', () => {
    const card: demo.DemoEvent[] = [
      { type: 'navigate', url: 'https://pago.example.com/' },
      { type: 'input', target: { name: 'cardnumber' }, value: '4111111111111111' },
      { type: 'input', target: { autocomplete: 'cc-csc', id: 'x' }, value: '737' },
      { type: 'input', target: { autocomplete: 'one-time-code', id: 'y' }, value: '123456' },
      { type: 'input', target: { ariaLabel: 'Contraseña' }, value: 'clave-ñ' },
    ];
    const text = JSON.stringify(m.recordDemo?.([...events, ...card], { env: ON }));
    expect(text).toContain('"ok":true');
    for (const secret of [PASS, '4111111111111111', '737', '123456', 'clave-ñ', 'user:pw']) {
      expect(text).not.toContain(secret);
    }
  });

  it('navegar a un host «nunca aprobar» (o a algo que no es http) aborta la grabación', () => {
    const bad = [...events, { type: 'navigate', url: 'https://www.Banco.ES./transferir' } as const];
    const r = m.recordDemo?.(bad, { env: ON, deniedHosts: ['banco.es'] });
    expect(r).toEqual({
      ok: false,
      reason: 'Grabación abortada: www.banco.es está en la lista «nunca aprobar».',
    });
    const file = m.recordDemo?.([{ type: 'navigate', url: 'file:///C:/secretos.txt' }], {
      env: ON,
    });
    expect(file?.ok).toBe(false);
  });

  it('un elemento sin selector estable aborta (no se graba un clic a ciegas)', () => {
    const r = m.recordDemo?.([{ type: 'click', target: { id: 'ember1234' } }], { env: ON });
    expect(r).toEqual({ ok: false, reason: 'No se pudo identificar el elemento del paso 1.' });
    expect(m.stableSelector?.({ id: ':r5:' })).toBeNull();
  });

  it('reproducir produce las mismas acciones en orden; los secretos siguen como marcador', () => {
    const r = m.recordDemo?.(events, { env: ON });
    if (!r?.ok) throw new Error('grabación falló');
    const actions = m.replayDemo?.(r, { buscar: 'té' }, { env: ON });
    expect(actions?.map((a) => a.action)).toEqual(r.steps.map((s) => s.action));
    expect(actions?.[1]).toEqual({
      action: 'fill',
      selector: 'input[name="email"]',
      value: 'nico@example.com',
    });
    expect(actions?.[2]).toEqual({
      action: 'fill',
      selector: '#pwd',
      secret: '{{vault:tienda.example.com:pwd}}',
    });
    expect(actions?.[5]).toEqual({
      action: 'fill',
      selector: 'input[aria-label="Buscar"]',
      value: 'té',
    });
    // Un host añadido después a «nunca aprobar» también para la reproducción.
    expect(() => m.replayDemo?.(r, {}, { env: ON, deniedHosts: ['example.com'] })).toThrow(
      /nunca aprobar/,
    );
    expect(() =>
      m.replayDemo?.(
        { steps: [{ action: 'fill', selector: '#a', param: 'x' }], params: {} },
        {},
        { env: ON },
      ),
    ).toThrow(/Falta el valor/);
  });

  it('tope de eventos', () => {
    const many = Array.from(
      { length: 201 },
      () => ({ type: 'click', target: { testId: 'a' } }) as const,
    );
    expect(m.recordDemo?.(many, { env: ON })?.ok).toBe(false);
  });
});
