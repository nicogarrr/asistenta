import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const stateDir = mkdtempSync(join(tmpdir(), 'pa-log-dd-'));
process.env.PA_STATE_DIR = stateDir;
process.env.PA_LOG_DAY_MAX_MB = String(4096 / (1024 * 1024));
delete process.env.PA_LOG_LEVEL;
const { log } = await import('../src/log.js');
const { localDay } = await import('../src/datecontext.js');
afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

describe('errores repetidos en bucle', () => {
  it('escribe solo los primeros y no llena el log; la línea fatal entra aunque esté lleno', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    for (let i = 0; i < 5000; i++) log.error('bucle igual', { i });
    for (let i = 0; i < 200; i++) log.error(`otro distinto ${i}`, { pad: 'x'.repeat(80) });
    log.error('uncaught exception, shutting down', { err: new Error('causa real') });
    const printed = out.mock.calls.length;
    out.mockRestore();
    expect(printed).toBeLessThan(400);
    const text = readFileSync(join(stateDir, 'log', `${localDay()}.jsonl`), 'utf8');
    expect(text.match(/"msg":"bucle igual"/g)).toHaveLength(20);
    expect(text).toContain('causa real');
  });
});
