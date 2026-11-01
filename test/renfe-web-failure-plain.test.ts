import type { Browser } from 'playwright';
import { describe, expect, it } from 'vitest';
import { createRenfeTool } from '../src/tools/renfe.js';

// A web failure mid-search (no network, Renfe slow) reaches the model as a plain
// Spanish line: the model repeats it in the chat. The raw Playwright text stays out.
const base = { origin: 'Madrid', destination: 'Sevilla', date: '2099-01-15' };

function browserFailingAt(message: string): Browser {
  const page = {
    setDefaultTimeout: () => {},
    goto: async () => {
      throw new Error(message);
    },
  };
  return {
    newContext: async () => ({ newPage: async () => page }),
    close: async () => {},
  } as unknown as Browser;
}

async function failure(message: string): Promise<Error | null> {
  const tool = createRenfeTool({ launch: async () => browserFailingAt(message) });
  return tool.execute('1', base).then(
    () => null,
    (e: Error) => e,
  );
}

describe('renfe: web failure in plain Spanish', () => {
  it('no network', async () => {
    const err = await failure(
      'page.goto: net::ERR_INTERNET_DISCONNECTED at https://www.renfe.com/es/es',
    );
    expect(err?.message).toBe(
      'Renfe falló: no hay conexión a internet o la web de Renfe no responde; prueba otra vez en un rato',
    );
  });

  it('Renfe too slow', async () => {
    const err = await failure('page.goto: Timeout 20000ms exceeded.');
    expect(err?.message).toMatch(/tardó demasiado en responder/);
    expect(err?.message).not.toMatch(/page\.goto|20000ms/);
  });

  it('anything else', async () => {
    const err = await failure('locator.fill: Target page, context or browser has been closed');
    expect(err?.message).toMatch(/la web de Renfe ha fallado o ha cambiado/);
    expect(err?.message).not.toMatch(/locator|Target page/);
  });
});
