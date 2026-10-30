import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const stateDir = mkdtempSync(join(tmpdir(), 'pa-auditoria-'));
process.env.PA_STATE_DIR = stateDir;

const { appendCallAudit, auditLedgerPath, hashArgs } = await import('../src/audit/calls.js');
const { auditCommand, parseSince } = await import('../src/audit/audit-cli.js');

afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

function capture() {
  let text = '';
  return {
    out: {
      write: (t: string) => {
        text += t;
      },
    },
    text: () => text,
  };
}

const file = join(stateDir, 'calls-test.jsonl');
appendCallAudit(
  { callId: 'a', tool: 'computer', argsHash: hashArgs({ x: 1 }), verdict: 'allow' },
  file,
);
appendCallAudit(
  {
    callId: 'b',
    tool: 'shell',
    argsHash: hashArgs({ c: 'rm' }),
    verdict: 'deny',
    reason: 'sin aprobación',
  },
  file,
);
appendCallAudit(
  { callId: 'c', tool: 'computer', argsHash: hashArgs({ x: 2 }), verdict: 'allow', isError: true },
  file,
);

describe('pa auditoria', () => {
  it('resume y lista las últimas llamadas en español', () => {
    const c = capture();
    expect(auditCommand([], { file, out: c.out })).toBe(0);
    expect(c.text()).toContain('3 llamadas: 2 permitidas, 1 denegadas, 1 con error.');
    expect(c.text()).toContain('computer 2, shell 1');
    expect(c.text()).toContain('shell DENEGADA (sin aprobación)');
  });

  it('filtra por herramienta y veredicto, y --json da datos', () => {
    const c = capture();
    expect(auditCommand(['--verdict', 'deny', '--json'], { file, out: c.out })).toBe(0);
    const parsed = JSON.parse(c.text());
    expect(parsed.summary.total).toBe(1);
    expect(parsed.recent[0].callId).toBe('b');
    const d = capture();
    auditCommand(['--tool', 'computer', '--last', '1'], { file, out: d.out });
    expect(d.text()).toContain('2 llamadas');
    expect(d.text()).toContain('Últimas 1:');
  });

  it('argumentos inválidos → uso y código 2; registro vacío → mensaje claro', () => {
    const err = capture();
    expect(auditCommand(['--verdict', 'quizas'], { file, err: err.out })).toBe(2);
    expect(err.text()).toContain('uso: pa auditoria');
    const c = capture();
    expect(auditCommand([], { file: join(stateDir, 'no-existe.jsonl'), out: c.out })).toBe(0);
    expect(c.text()).toContain('No hay llamadas registradas');
  });

  it('--since acepta 24h/7d', () => {
    const now = Date.parse('2026-10-30T12:00:00Z');
    expect(parseSince('24h', now)).toBe('2026-10-29T12:00:00.000Z');
    expect(parseSince('7d', now)).toBe('2026-10-23T12:00:00.000Z');
    expect(parseSince('2026-10-01T00:00:00Z', now)).toBe('2026-10-01T00:00:00Z');
  });

  it('el binario `pa` enruta `auditoria` al comando y lee el registro del estado', async () => {
    appendCallAudit(
      { callId: 'z', tool: 'tv', argsHash: hashArgs({}), verdict: 'allow' },
      auditLedgerPath(),
    );
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const { main } = await import('../src/cli.js');
      expect(await main(['auditoria', '--json'])).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const parsed = JSON.parse(writes.join(''));
    expect(parsed.summary.byTool).toEqual({ tv: 1 });
  });
});
