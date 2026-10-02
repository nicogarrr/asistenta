import { describe, expect, it } from 'vitest';
import { Gate } from '../src/permissions.js';

const base = { protectedPaths: ['C:\\Users\\nicoi\\.ssh'] };

describe('Gate full control', () => {
  it('allows clicking and typing without asking', async () => {
    const gate = new Gate({ ...base, fullControl: true });
    const click = await gate.check('s1', {
      tool: 'computer',
      args: { action: 'click', x: 10, y: 10 },
      actor: '@me',
    });
    const type = await gate.check('s1', {
      tool: 'computer',
      args: { action: 'type', text: 'hola' },
      actor: '@me',
    });
    expect(click.verdict).toBe('allow');
    expect(type.verdict).toBe('allow');
    expect(click.reason).toBe('full control');
  });

  it('still allows the shell', async () => {
    const gate = new Gate({ ...base, fullControl: true });
    const d = await gate.check('s1', {
      tool: 'shell',
      args: { command: 'Get-ChildItem' },
      actor: '@me',
    });
    expect(d.verdict).toBe('allow');
  });

  it('still honours the deny list', async () => {
    // A wall is not a prompt: full control must not be able to talk past it.
    const gate = new Gate({ ...base, fullControl: true, deny: ['shell'] });
    const d = await gate.check('s1', {
      tool: 'shell',
      args: { command: 'dir' },
      actor: '@me',
    });
    expect(d.verdict).toBe('deny');
  });

  it('still refuses to write to protected paths', async () => {
    const gate = new Gate({ ...base, fullControl: true });
    const d = await gate.check('s1', {
      tool: 'write',
      args: { path: 'C:\\Users\\nicoi\\.ssh\\id_rsa', content: 'x' },
      actor: '@me',
    });
    expect(d.verdict).toBe('deny');
  });

  it('still asks about payments unless explicitly allowed', async () => {
    let asked = 0;
    const gate = new Gate({
      ...base,
      fullControl: true,
      approver: () => {
        asked++;
        return true;
      },
    });
    const d = await gate.check('s1', {
      tool: 'shell',
      args: { command: 'curl -d card=4111111111111111' },
      actor: '@me',
    });
    // It falls through to the normal ask path rather than being denied outright.
    expect(asked).toBe(1);
    expect(d.verdict).toBe('allow');
    expect(d.reason).toBe('approved by @me');
  });

  it('auto-approves payments when allowPayments is set', async () => {
    let asked = 0;
    const gate = new Gate({
      ...base,
      fullControl: true,
      allowPayments: true,
      approver: () => {
        asked++;
        return true;
      },
    });
    const d = await gate.check('s1', {
      tool: 'shell',
      args: { command: 'curl -d card=4111111111111111' },
      actor: '@me',
    });
    expect(asked).toBe(0);
    expect(d.verdict).toBe('allow');
  });
});

describe('Gate grant window scope', () => {
  it('does not extend a shell approval to a different command', async () => {
    // The critical case: approve `echo ok`, then `Remove-Item -Recurse` must ask
    // again. A window on shell would turn one benign approval into 90s of
    // arbitrary commands.
    let asked = 0;
    const gate = new Gate({
      ...base,
      grantWindowMs: 60_000,
      approver: () => {
        asked++;
        return true;
      },
    });
    await gate.check('s1', { tool: 'shell', args: { command: 'echo ok' }, actor: 'me' });
    await gate.check('s1', {
      tool: 'shell',
      args: { command: 'Remove-Item -Recurse C:\\x' },
      actor: 'me',
    });
    expect(asked).toBe(2);
  });

  it('still asks for credentials in full control, with no override', async () => {
    // Reading id_rsa or vault.enc must never pass silently: with shell access
    // those files decrypt to everything. There is deliberately no flag for this.
    for (const args of [
      { path: 'C:\\Users\\nicoi\\.ssh\\id_rsa' },
      { command: 'Get-Content $env:USERPROFILE\\.local\\share\\personal-agent\\vault.enc' },
    ]) {
      let asked = 0;
      const gate = new Gate({
        ...base,
        fullControl: true,
        allowPayments: true,
        approver: () => {
          asked++;
          return true;
        },
      });
      const tool = 'path' in args ? 'read' : 'shell';
      const d = await gate.check('s1', { tool, args, actor: 'me' });
      expect(asked, JSON.stringify(args)).toBe(1);
      expect(d.verdict).toBe('allow');
    }
  });

  it('catches spaced and dashed card numbers', async () => {
    let asked = 0;
    const gate = new Gate({
      ...base,
      fullControl: true,
      approver: () => {
        asked++;
        return true;
      },
    });
    await gate.check('s1', {
      tool: 'shell',
      args: { command: 'pay 4111 1111 1111 1111' },
      actor: 'me',
    });
    await gate.check('s1', {
      tool: 'shell',
      args: { command: 'send 4111-1111-1111-1111' },
      actor: 'me',
    });
    expect(asked).toBe(2);
  });
});

describe('Gate approval window', () => {
  it('stops asking for the same tool after one approval', async () => {
    let asked = 0;
    const gate = new Gate({
      ...base,
      grantWindowMs: 60_000,
      approver: () => {
        asked++;
        return true;
      },
    });

    // Three different clicks: each has different coordinates, so a fingerprint-only
    // memo would ask three times. This is the "it asked me 3 times" bug.
    await gate.check('s1', {
      tool: 'computer',
      args: { action: 'click', x: 1, y: 1 },
      actor: 'me',
    });
    await gate.check('s1', {
      tool: 'computer',
      args: { action: 'click', x: 2, y: 2 },
      actor: 'me',
    });
    await gate.check('s1', {
      tool: 'computer',
      args: { action: 'click', x: 3, y: 3 },
      actor: 'me',
    });
    expect(asked).toBe(1);
  });

  it('does not let the window leak to a different tool', async () => {
    let asked = 0;
    const gate = new Gate({
      ...base,
      grantWindowMs: 60_000,
      approver: () => {
        asked++;
        return true;
      },
    });
    await gate.check('s1', {
      tool: 'computer',
      args: { action: 'click', x: 1, y: 1 },
      actor: 'me',
    });
    await gate.check('s1', { tool: 'shell', args: { command: 'dir' }, actor: 'me' });
    expect(asked).toBe(2);
  });

  it('does not let the window cover payments', async () => {
    let asked = 0;
    const gate = new Gate({
      ...base,
      grantWindowMs: 60_000,
      approver: () => {
        asked++;
        return true;
      },
    });
    await gate.check('s1', { tool: 'shell', args: { command: 'dir' }, actor: 'me' });
    // The shell grant must not extend to money.
    await gate.check('s1', {
      tool: 'shell',
      args: { command: 'pay card 4111111111111111' },
      actor: 'me',
    });
    expect(asked).toBe(2);
  });

  it('expires the window', async () => {
    let asked = 0;
    const gate = new Gate({
      ...base,
      grantWindowMs: 1,
      approver: () => {
        asked++;
        return true;
      },
    });
    await gate.check('s1', {
      tool: 'computer',
      args: { action: 'click', x: 1, y: 1 },
      actor: 'me',
    });
    await new Promise((r) => setTimeout(r, 5));
    await gate.check('s1', {
      tool: 'computer',
      args: { action: 'click', x: 9, y: 9 },
      actor: 'me',
    });
    expect(asked).toBe(2);
  });

  it('drops the window when the session ends', async () => {
    let asked = 0;
    const gate = new Gate({
      ...base,
      grantWindowMs: 60_000,
      approver: () => {
        asked++;
        return true;
      },
    });
    await gate.check('s1', {
      tool: 'computer',
      args: { action: 'click', x: 1, y: 1 },
      actor: 'me',
    });
    gate.clearSession('s1');
    await gate.check('s1', {
      tool: 'computer',
      args: { action: 'click', x: 2, y: 2 },
      actor: 'me',
    });
    expect(asked).toBe(2);
  });
});
