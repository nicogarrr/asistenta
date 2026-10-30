import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as cli from '../src/cli.js';
import * as gate from '../src/daemon/gate.js';

// P2 (ARCHITECTURE.md): the daemon's gate wiring lives in src/daemon/gate.ts;
// cli.ts re-exports the very same functions, so every existing import keeps working.
describe('daemon gate module', () => {
  it('cli.ts re-exports the same functions (pure move)', () => {
    expect(typeof gate.createDaemonGate).toBe('function');
    expect(cli.createDaemonGate).toBe(gate.createDaemonGate);
    expect(cli.approvalsDbPath).toBe(gate.approvalsDbPath);
  });

  it('secret files stay both unreadable and unwritable', () => {
    expect(gate.approvalsDbPath('/x')).toBe(join('/x', 'approvals.db'));
    const secrets = gate.secretStatePaths();
    expect(secrets).toContain(gate.approvalsDbPath());
    expect(secrets).toContain(resolve('.env'));
    const protectedList = gate.protectedPaths();
    for (const p of secrets) expect(protectedList).toContain(p);
    expect(protectedList).toContain('C:\\Windows\\System32');
  });
});
