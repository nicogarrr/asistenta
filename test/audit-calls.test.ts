import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendCallAudit, hashArgs, verifyCallAudit } from '../src/audit/calls.js';

// Auditoría durable: una línea por llamada, encadenada por hash. Debe detectar
// una línea editada y una línea borrada, y NUNCA guardar los argumentos (solo su
// hash): un comando puede llevar un token.
describe('auditoría durable por llamada', () => {
  it('encadena hashes y detecta edición y borrado', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-audit-calls-'));
    const file = join(dir, 'calls.jsonl');
    try {
      for (let i = 0; i < 3; i++) {
        appendCallAudit(
          {
            callId: `c${i}`,
            tool: 'read',
            argsHash: hashArgs({ path: `f${i}` }),
            verdict: 'allow',
            isError: false,
            ms: i + 1,
          },
          file,
        );
      }
      expect(verifyCallAudit(file)).toEqual({ ok: true, entries: 3 });

      const lines = readFileSync(file, 'utf8').trim().split('\n');
      const middle = JSON.parse(lines[1] as string) as { tool: string };
      middle.tool = 'shell';
      lines[1] = JSON.stringify(middle);
      writeFileSync(file, `${lines.join('\n')}\n`);
      const edited = verifyCallAudit(file);
      expect(edited.ok).toBe(false);
      expect(edited.brokenAt).toBe(2);
      expect(edited.reason).toContain('editada');

      writeFileSync(file, `${[lines[0], lines[2]].join('\n')}\n`);
      const deleted = verifyCallAudit(file);
      expect(deleted.ok).toBe(false);
      expect(deleted.brokenAt).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('el hash de argumentos no contiene los valores y es estable', () => {
    const h = hashArgs({ command: 'curl -H "Authorization: Bearer SECRETO" https://x' });
    expect(h).toMatch(/^[a-f0-9]{32}$/);
    expect(h).not.toContain('SECRETO');
    expect(hashArgs({ b: 1, a: 2 })).toBe(hashArgs({ a: 2, b: 1 }));
  });
});
