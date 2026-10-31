/**
 * El auto-chequeo mira lo que de verdad hay configurado en el PC, no «sin comprobar».
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectSkillEnv } from '../src/skills/env.js';
import { SkillStore } from '../src/skills/store.js';
import { createSkillsTool } from '../src/tools/skills.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

function probes(vault: Record<string, string>, tools: string[] = [], ics = false) {
  return {
    vault: async (key: string) => vault[key],
    hasLocalCalendar: () => ics,
    toolNames: () => tools,
  };
}

describe('qué hay configurado para las habilidades', () => {
  it('correo con la cuenta de lectura o la antigua; nada si falta la contraseña', async () => {
    const read = await detectSkillEnv(
      probes({ 'mailRead:address': 'a@b.es', 'mailRead:password': 'x' }),
    );
    expect(read.capabilities?.has('correo')).toBe(true);
    const old = await detectSkillEnv(probes({ 'mail:address': 'a@b.es', 'mail:password': 'x' }));
    expect(old.capabilities?.has('correo')).toBe(true);
    const half = await detectSkillEnv(probes({ 'mailRead:address': 'a@b.es' }));
    expect(half.capabilities?.has('correo')).toBe(false);
  });

  it('calendario con el ics local o la URL; navegador y casa por herramienta', async () => {
    const env = await detectSkillEnv(probes({}, ['browser', 'skills'], true));
    expect(env.capabilities?.has('calendario')).toBe(true);
    expect(env.capabilities?.has('navegador')).toBe(true);
    expect(env.capabilities?.has('casa')).toBe(false);
    expect(env.toolNames).toEqual(['browser', 'skills']);
    const url = await detectSkillEnv(probes({ 'calendar:icsUrl': 'https://x/cal.ics' }));
    expect(url.capabilities?.has('calendario')).toBe(true);
    expect(url.capabilities?.has('navegador')).toBe(false);
  });

  it('un vault que falla cuenta como no configurado, sin romper', async () => {
    const env = await detectSkillEnv({
      vault: async () => {
        throw new Error('vault cerrado');
      },
      hasLocalCalendar: () => false,
      toolNames: () => {
        throw new Error('x');
      },
    });
    expect(env.capabilities?.has('correo')).toBe(false);
    expect(env.toolNames).toEqual([]);
  });
});

describe('skills check con el entorno real', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-skillenv-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  it('acepta un checkEnv asíncrono y deja de decir «sin comprobar»', async () => {
    const store = new SkillStore({ dir });
    const id = store.save({
      name: 'Facturas',
      description: 'Facturas del correo',
      category: 'casa',
      whenToUse: 'cuando llega una factura',
      steps: ['buscar facturas en el correo', 'resumir importes'],
      needs: ['correo'],
    });
    const tool = createSkillsTool({
      store,
      checkEnv: () =>
        detectSkillEnv(probes({ 'mailRead:address': 'a@b.es', 'mailRead:password': 'x' })),
    });
    const res = await tool.execute('t1', { action: 'check', id }, undefined, undefined);
    const out = res.content.map((p) => ('text' in p ? p.text : '')).join('\n');
    expect(out).toContain('está lista');
    expect(out).not.toContain('Sin comprobar');
  });

  it('cli.ts pasa un checkEnv real al crear la herramienta', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toMatch(/createSkillsTool\(\{[\s\S]{0,300}checkEnv:/);
    expect(cli).toContain('detectSkillEnv(');
  });
});
