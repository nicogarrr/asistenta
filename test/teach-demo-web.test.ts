import { describe, expect, it } from 'vitest';
import type { Playbook } from '../src/gestor/playbooks.js';
import { type DemoBrowser, parseDemoEvents, WebDemoRecorder } from '../src/teach-demo-web.js';

const ON = { PA_TEACH_DEMO: '1' };

/** Navegador falso: responde al protocolo de execJs sin abrir nada. */
function fakeBrowser(events: unknown[]): DemoBrowser & { opened: string[] } {
  let on = false;
  const opened: string[] = [];
  return {
    opened,
    async open(_scope, url) {
      opened.push(url);
      return {};
    },
    async execJs(_scope, code) {
      if (code.includes("return 'paDemo:ok'")) {
        on = true;
        return { text: 'paDemo:ok', timedOut: false };
      }
      if (code.includes('state.paDemoOn = false')) {
        expect(on).toBe(true);
        return { text: `paDemo:${events.length}`, timedOut: false };
      }
      const m = /slice\((\d+), (\d+)\)/.exec(code);
      if (!m) return { text: 'error: desconocido', timedOut: false };
      return {
        text: JSON.stringify(events.slice(Number(m[1]), Number(m[2]))),
        timedOut: false,
      };
    },
  };
}

function memStore() {
  const saved = new Map<string, Playbook>();
  return {
    saved,
    read: (d: string) => saved.get(d) ?? null,
    save: (pb: Playbook) => void saved.set(pb.domain, pb),
  };
}

const demo = [
  { type: 'navigate', url: 'https://www.example.com/login' },
  {
    type: 'input',
    target: { tag: 'input', name: 'email', inputType: 'email' },
    value: 'nico@correo.es',
  },
  {
    type: 'input',
    target: { tag: 'input', name: 'pass', inputType: 'password' },
    value: 'Sup3rS3creta',
  },
  { type: 'click', target: { tag: 'button', id: 'entrar', text: 'Entrar' } },
  { type: 'submit', target: { tag: 'form', id: 'login' } },
];

describe('/learn web (F11 paso 3)', () => {
  it('apagado (por defecto): no abre nada y deja el /learn de siempre', async () => {
    const rec = new WebDemoRecorder();
    const browser = fakeBrowser(demo);
    expect(await rec.start('c1', 'https://example.com', { browser, env: {} })).toBeNull();
    expect(browser.opened).toEqual([]);
    expect(rec.isRecording('c1')).toBe(false);
    const store = memStore();
    expect(
      await rec.finish('c1', { browser, store, vaultValues: async () => [], env: {} }),
    ).toBeNull();
  });

  it('graba, convierte y guarda el playbook sin valores ni secretos', async () => {
    const rec = new WebDemoRecorder();
    const browser = fakeBrowser(demo);
    const msg = await rec.start('c1', 'https://user:pw@example.com/login', { browser, env: ON });
    expect(msg).toContain('Grabando');
    expect(browser.opened).toEqual(['https://example.com/login']);
    expect(rec.isRecording('c1')).toBe(true);
    const store = memStore();
    const done = await rec.finish('c1', { browser, store, vaultValues: async () => [], env: ON });
    expect(done).toContain('Playbook de example.com guardado');
    expect(rec.isRecording('c1')).toBe(false);
    const pb = store.saved.get('example.com');
    expect(pb).toBeDefined();
    const all = JSON.stringify(pb);
    expect(all).toContain('#entrar');
    expect(all).toContain('vault:');
    expect(all).not.toContain('nico@correo.es');
    expect(all).not.toContain('Sup3rS3creta');
  });

  it('no guarda si el playbook coincide con un valor del vault', async () => {
    const rec = new WebDemoRecorder();
    const browser = fakeBrowser(demo);
    await rec.start('c1', 'https://example.com/login', { browser, env: ON });
    const store = memStore();
    const done = await rec.finish('c1', {
      browser,
      store,
      vaultValues: async () => ['entrar'],
      env: ON,
    });
    expect(done).toContain('no se guarda');
    expect(store.saved.size).toBe(0);
  });

  it('/learn web sin URL válida explica el uso y no abre nada', async () => {
    const rec = new WebDemoRecorder();
    const browser = fakeBrowser(demo);
    expect(await rec.start('c1', 'file:///etc/passwd', { browser, env: ON })).toContain(
      '¿En qué web te miro?',
    );
    expect(await rec.start('c1', '', { browser, env: ON })).toContain('¿En qué web te miro?');
    expect(browser.opened).toEqual([]);
  });

  it('descarta eventos raros de la página y vacía valores sensibles', () => {
    const out = parseDemoEvents([
      null,
      { type: 'eval', code: 'x' },
      { type: 'click', target: { id: 'a'.repeat(500) } },
      { type: 'click', target: { id: 7 } },
      { type: 'input', target: { name: 'cvv', autocomplete: 'cc-csc' }, value: '123' },
      { type: 'click', target: { id: 'ok' } },
    ]);
    expect(out).toEqual([
      { type: 'input', target: { name: 'cvv', autocomplete: 'cc-csc' }, value: '' },
      { type: 'click', target: { id: 'ok' } },
    ]);
  });
});
