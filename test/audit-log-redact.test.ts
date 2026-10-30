import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ActionLog } from '../src/audit/log.js';

const dirs: string[] = [];
function tmpLog(): string {
  const dir = mkdtempSync(join(tmpdir(), 'audit-redact-'));
  dirs.push(dir);
  return join(dir, 'actions.jsonl');
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('ActionLog tapa secretos en target/detail', () => {
  it('no escribe en disco un token de una URL ni un password=…', () => {
    const file = tmpLog();
    const actions = new ActionLog({ file });
    actions.record({
      actor: 'agent',
      action: 'fetch',
      result: 'ok',
      target: 'https://api.example.com/v1?token=abc123SECRETxyz&q=1',
      detail: 'shell: login --password=hunter2xyz con Bearer eyJhbGciOiJIUzI1NiJ9.payload',
    });
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('abc123SECRETxyz');
    expect(raw).not.toContain('hunter2xyz');
    expect(raw).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    const line = JSON.parse(raw.trim());
    expect(line.target).toContain('api.example.com');
  });

  it('el resumen tampoco enseña secretos de entradas antiguas sin tapar', () => {
    const file = tmpLog();
    const old = {
      ts: new Date().toISOString(),
      actor: 'agent',
      action: 'shell',
      result: 'ok',
      target: 'curl -H "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789"',
      detail: 'api_key=sk-livesecret0000',
    };
    writeFileSync(file, `${JSON.stringify(old)}\n`);
    const text = new ActionLog({ file }).summary(24);
    expect(text).toContain('shell');
    expect(text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(text).not.toContain('sk-livesecret0000');
  });
});
