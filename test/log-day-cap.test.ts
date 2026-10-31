import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * Un bucle de errores podía llenar el disco en un día: log/AAAA-MM-DD.jsonl no
 * tenía tope y la poda por antigüedad viene apagada. Tope por día, un aviso.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-log-cap-'));
process.env.PA_STATE_DIR = stateDir;
process.env.PA_LOG_DAY_MAX_MB = String(4096 / (1024 * 1024)); // 4 KB
delete process.env.PA_LOG_LEVEL;

const { log } = await import('../src/log.js');
const { localDay } = await import('../src/datecontext.js');

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
  delete process.env.PA_LOG_DAY_MAX_MB;
});

const logDir = join(stateDir, 'log');
const today = (): string => join(logDir, `${localDay()}.jsonl`);

describe('tope diario del registro', () => {
  it('al llegar al tope escribe un aviso una vez y deja de crecer; la consola sigue', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    for (let i = 0; i < 200; i++) log.error('bucle de errores', { i, pad: 'x'.repeat(80) });
    const printed = out.mock.calls.length;
    out.mockRestore();
    expect(printed).toBe(200);
    expect(readdirSync(logDir)).toHaveLength(1);
    const text = readFileSync(today(), 'utf8');
    expect(Buffer.byteLength(text)).toBeLessThan(4096 + 400);
    expect(text.match(/log del día lleno/g)).toHaveLength(1);
    expect(text).toContain('"i":0');
    expect(text).not.toContain('"i":199');
  });

  it('tras un reinicio cuenta lo que el fichero de hoy ya tenía', async () => {
    vi.resetModules();
    writeFileSync(today(), `${'y'.repeat(5000)}\n`);
    const fresh = await import('../src/log.js');
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    fresh.log.info('primera línea tras reiniciar');
    fresh.log.info('segunda');
    out.mockRestore();
    const text = readFileSync(today(), 'utf8');
    expect(text).not.toContain('primera línea tras reiniciar');
    expect(text.match(/log del día lleno/g)).toHaveLength(1);
  });
});
