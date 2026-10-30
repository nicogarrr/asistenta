import { describe, expect, it } from 'vitest';
import type { DemoBrowser } from '../src/teach-demo-web.js';
import { WebDemoRecorder } from '../src/teach-demo-web.js';

const ON = { PA_TEACH_DEMO: '1' };

function fakeBrowser(): DemoBrowser & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async open() {
      return {};
    },
    async execJs(_scope, code) {
      if (code.includes("return 'paDemo:ok'")) {
        calls.push('start');
        return { text: 'paDemo:ok', timedOut: false };
      }
      if (code.includes('state.paDemoOn = false')) {
        calls.push('stop');
        return { text: 'paDemo:0', timedOut: false };
      }
      calls.push('read');
      return { text: '[]', timedOut: false };
    },
  };
}

const memStore = () => {
  const saved: unknown[] = [];
  return { saved, read: () => null, save: (pb: unknown) => void saved.push(pb) };
};

describe('/learn web: la grabación caduca y los errores son amables', () => {
  it('pasados 30 min ya no está grabando y /learn end no guarda nada', async () => {
    let now = 1_000_000;
    const rec = new WebDemoRecorder({ now: () => now });
    const browser = fakeBrowser();
    expect(await rec.start('c1', 'https://example.com', { browser, env: ON })).toContain(
      'Grabando',
    );
    now += 29 * 60_000;
    expect(rec.isRecording('c1')).toBe(true);
    now += 2 * 60_000;
    expect(rec.isRecording('c1')).toBe(false);
    const store = memStore();
    const msg = await rec.finish('c1', {
      browser,
      store: store as never,
      vaultValues: async () => [],
      env: ON,
    });
    expect(msg).toContain('caducó');
    expect(msg).toContain('example.com');
    expect(store.saved).toEqual([]);
    expect(browser.calls).toEqual(['start', 'stop']);
    // Ya no queda nada: un segundo /learn end vuelve al /learn de siempre.
    expect(
      await rec.finish('c1', {
        browser,
        store: store as never,
        vaultValues: async () => [],
        env: ON,
      }),
    ).toBeNull();
  });

  it('si el navegador no abre, frase en castellano sin el error en bruto', async () => {
    const rec = new WebDemoRecorder();
    const browser: DemoBrowser = {
      async open() {
        throw new Error('ECONNREFUSED 127.0.0.1:9222 browserType.launch');
      },
      async execJs() {
        return { text: '', timedOut: false };
      },
    };
    const msg = await rec.start('c1', 'https://example.com', { browser, env: ON });
    expect(msg).toBe('No pude abrir el navegador para grabar. Prueba otra vez con /learn web.');
    expect(rec.isRecording('c1')).toBe(false);
  });
});
