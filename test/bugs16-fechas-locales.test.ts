import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Las fechas que se enseñan son el día de Nico (Madrid), no el día UTC: a las 00:30
// del 2 de noviembre en Madrid son las 23:30 UTC del 1.
const dir = mkdtempSync(join(tmpdir(), 'pa-bugs16-fechas-'));
vi.mock('../src/paths.js', async (original) => {
  const real = await original<typeof import('../src/paths.js')>();
  return { ...real, STATE_DIR: dir, paths: { ...real.paths, state: dir } };
});

const { DocMemory } = await import('../src/memory/docs.js');
const { createDocsTool } = await import('../src/tools/docs.js');
const { createMailRulesTool } = await import('../src/tools/mail-rules.js');

const NOCHE = Date.UTC(2026, 10, 1, 23, 30); // 2 nov 00:30 en Madrid
const prevTz = process.env.PA_TIMEZONE;
beforeAll(() => {
  process.env.PA_TIMEZONE = 'Europe/Madrid';
});
afterAll(() => {
  if (prevTz === undefined) delete process.env.PA_TIMEZONE;
  else process.env.PA_TIMEZONE = prevTz;
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const textOf = (r: unknown): string =>
  (r as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? '').join('\n');

describe('fechas en día local (bugs16)', () => {
  it('documents search: un PDF que llegó a las 00:30 sale con el día de hoy, no el de ayer', async () => {
    const mem = new DocMemory({
      dbPath: join(dir, 'd.sqlite'),
      directory: join(dir, 'm'),
      now: () => NOCHE,
    });
    await mem.index(
      'telegram:main:1#main',
      { fileId: 'f1', name: 'factura-luz.pdf', mimeType: 'text/plain' },
      Buffer.from('factura de la luz de octubre importe total'),
    );
    const tool = createDocsTool(mem, () => 'telegram:main:1#main');
    const out = textOf(await tool.execute('t', { action: 'search', query: 'factura luz' }));
    expect(out).toContain('2026-11-02');
    expect(out).not.toContain('2026-11-01');
  });

  it('bajas de correo: una baja hecha a las 00:30 sale con el día de hoy', async () => {
    writeFileSync(
      join(dir, 'mail-unsubscribed.json'),
      JSON.stringify([
        {
          remitente: 'news@a.example',
          metodo: 'un-clic',
          hora: new Date(NOCHE).toISOString(),
          resultado: 'hecho',
        },
      ]),
    );
    const tool = createMailRulesTool({
      account: async () => ({
        address: 'n@x.example',
        password: 'p',
        imapHost: 'h',
        imapPort: 993,
        smtpHost: 's',
        smtpPort: 465,
      }),
      rulesFile: join(dir, 'r.json'),
    } as never);
    const out = textOf(await tool.execute('t', { action: 'bajas' } as never));
    expect(out).toContain('news@a.example');
    expect(out).toContain('2026-11-02');
    expect(out).not.toContain('2026-11-01');
  });
});
