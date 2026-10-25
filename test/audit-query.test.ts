import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendCallAudit, hashArgs } from '../src/audit/calls.js';
import { filterCallAudit, readCallAudit, summarizeCallAudit } from '../src/audit/query.js';

/**
 * La auditoría tiene que poder consultarse sin perder la garantía de cadena:
 * leer un fichero manipulado debe fallar, no devolver una verdad a medias.
 */
describe('consulta de la auditoría de llamadas', () => {
  it('un fichero inexistente es una auditoría vacía', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-audit-query-'));
    try {
      expect(readCallAudit(join(dir, 'no-existe.jsonl'))).toEqual([]);
      expect(summarizeCallAudit([])).toEqual({
        total: 0,
        allows: 0,
        denies: 0,
        errors: 0,
        byTool: {},
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lee en orden y resume veredictos, errores, herramientas y extremos', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-audit-query-'));
    const file = join(dir, 'calls.jsonl');
    try {
      appendCallAudit(
        {
          callId: 'c1',
          tool: 'read',
          argsHash: hashArgs({ path: 'a.txt' }),
          verdict: 'allow',
          isError: false,
          ms: 5,
        },
        file,
      );
      appendCallAudit(
        {
          callId: 'c2',
          tool: 'shell',
          argsHash: hashArgs({ command: 'dir' }),
          verdict: 'deny',
          reason: 'destructive or privilege-raising shell command',
        },
        file,
      );
      appendCallAudit(
        {
          callId: 'c3',
          tool: 'read',
          argsHash: hashArgs({ path: 'b.txt' }),
          verdict: 'allow',
          isError: true,
          ms: 9,
        },
        file,
      );

      const lines = readCallAudit(file);
      expect(lines.map((l) => l.callId)).toEqual(['c1', 'c2', 'c3']);
      expect(lines[0]?.v).toBe(1);
      expect(lines[0]?.h).toMatch(/^[a-f0-9]{64}$/);

      const summary = summarizeCallAudit(lines);
      expect(summary.total).toBe(3);
      expect(summary.allows).toBe(2);
      expect(summary.denies).toBe(1);
      expect(summary.errors).toBe(1);
      expect(summary.byTool).toEqual({ read: 2, shell: 1 });
      expect(summary.first).toBe(lines[0]?.ts);
      expect(summary.last).toBe(lines[2]?.ts);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('filtra por herramienta, veredicto, callId y desde una fecha', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-audit-query-'));
    const file = join(dir, 'calls.jsonl');
    try {
      const before = new Date(Date.now() - 1_000).toISOString();
      for (const [id, tool, verdict] of [
        ['c1', 'read', 'allow'],
        ['c2', 'shell', 'deny'],
        ['c3', 'read', 'allow'],
      ] as const) {
        appendCallAudit(
          {
            callId: id,
            tool,
            argsHash: hashArgs({ id }),
            verdict,
          },
          file,
        );
      }
      const lines = readCallAudit(file);

      expect(filterCallAudit(lines, { tool: 'read' }).map((l) => l.callId)).toEqual(['c1', 'c3']);
      expect(filterCallAudit(lines, { verdict: 'deny' }).map((l) => l.callId)).toEqual(['c2']);
      expect(filterCallAudit(lines, { callId: 'c2' }).map((l) => l.tool)).toEqual(['shell']);
      expect(filterCallAudit(lines, { since: before })).toHaveLength(3);
      expect(filterCallAudit(lines, { since: '2999-01-01T00:00:00.000Z' })).toEqual([]);
      expect(
        filterCallAudit(lines, { tool: 'read', verdict: 'allow', since: before }).map(
          (l) => l.callId,
        ),
      ).toEqual(['c1', 'c3']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rechaza un ledger manipulado y dice la línea rota', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-audit-query-'));
    const file = join(dir, 'calls.jsonl');
    try {
      appendCallAudit(
        { callId: 'c1', tool: 'read', argsHash: hashArgs({ path: 'a' }), verdict: 'allow' },
        file,
      );
      appendCallAudit(
        { callId: 'c2', tool: 'read', argsHash: hashArgs({ path: 'b' }), verdict: 'allow' },
        file,
      );
      const lines = readFileSync(file, 'utf8').trim().split('\n');
      const middle = JSON.parse(lines[1] as string) as { tool: string };
      middle.tool = 'shell';
      lines[1] = JSON.stringify(middle);
      writeFileSync(file, `${lines.join('\n')}\n`);

      expect(() => readCallAudit(file)).toThrow(/línea 2/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
