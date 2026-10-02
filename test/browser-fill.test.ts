import { describe, expect, it } from 'vitest';
import { buildFillScript } from '../src/tools/browser.js';

type Fake = { value: string; calls: string[] };

function fakePage(
  onType: (f: Fake, text: string) => void,
  onFill: (f: Fake, text: string) => void,
) {
  const f: Fake = { value: '', calls: [] };
  const loc = {
    first: () => loc,
    fill: async (t: string) => {
      f.calls.push(`fill:${t}`);
      onFill(f, t);
    },
    click: async () => f.calls.push('click'),
    press: async (k: string) => {
      f.calls.push(`press:${k}`);
      if (k === 'Delete') f.value = '';
    },
    pressSequentially: async (t: string) => {
      f.calls.push(`type:${t}`);
      onType(f, t);
    },
    inputValue: async () => f.value,
  };
  return { f, page: { locator: () => loc, waitForTimeout: async () => {} } };
}

async function run(script: string, page: unknown): Promise<string> {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  return new AsyncFunction('page', script)(page);
}

describe('buildFillScript', () => {
  it('relleno correcto: no reintenta', async () => {
    const { page, f } = fakePage(
      (x, t) => {
        x.value = t;
      },
      (x, t) => {
        x.value = t;
      },
    );
    const out = await run(buildFillScript('#origen', 'Madrid'), page);
    expect(out).toBe('filled #origen');
    expect(f.calls.some((c) => c.startsWith('type:'))).toBe(false);
  });

  it('autocompletado que duplica «MadridMadrid»: limpia y reescribe', async () => {
    const { page, f } = fakePage(
      (x, t) => {
        x.value = t;
      },
      (x, t) => {
        x.value = x.value === '' || t === '' ? t + t : t;
        if (t === '') x.value = '';
        else x.value = t + t;
      },
    );
    const out = await run(buildFillScript('#origen', 'Madrid'), page);
    expect(out).toContain('reintentado');
    expect(f.value).toBe('Madrid');
  });

  it('si sigue mal avisa con el valor real en vez de decir filled', async () => {
    const { page } = fakePage(
      (x, t) => {
        x.value = `${t}${t}`;
      },
      (x, t) => {
        x.value = t === '' ? '' : `${t}${t}`;
      },
    );
    const out = await run(buildFillScript('#origen', 'Madrid'), page);
    expect(out).toContain('ATENCIÓN');
    expect(out).toContain('MadridMadrid');
  });
});
