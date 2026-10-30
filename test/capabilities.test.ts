import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  deferredSpecs,
  desktopOnlyToolNames,
  LOADER_TOOL_NAME,
  machineToolNames,
  threadAllowToolNames,
} from '../src/core/capabilities.js';
import { MACHINE_TOOLS } from '../src/core/tool-registry.js';
import { DEFERRED_DEFAULTS, THREAD_ALLOW_TOOLS } from '../src/core/toolset.js';
import { checkPatch } from '../src/evolve/guard.js';
import { DESKTOP_ONLY_TOOLS } from '../src/platform.js';

// Valores exactos que tenían las cuatro listas sueltas antes del catálogo (main 76667ff).
// Si cambias el catálogo a propósito, actualiza esto en la misma PR: es el contrato.
const BEFORE = {
  machine: ['computer', 'shell', 'browser', 'checkout', 'write', 'media'],
  desktop: ['computer', 'windows', 'ocr', 'system', 'shell', 'media', 'tv', 'iphone'],
  threadAllow: [
    'read',
    'list',
    'fetch',
    'done',
    'preguntar',
    'memory',
    'reminder',
    'agenda',
    'opengym',
    'book',
    'objetivo',
    'gestion',
    'delegate',
    'cargar_herramienta',
  ],
  deferred: ['browser', 'delegate', 'media'],
};

describe('catálogo de capacidades (P1)', () => {
  it('cada herramienta aparece una sola vez', () => {
    const names = CAPABILITIES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('MACHINE_TOOLS sale del catálogo con los mismos nombres que antes', () => {
    expect([...MACHINE_TOOLS].sort()).toEqual([...BEFORE.machine].sort());
    expect(machineToolNames().sort()).toEqual([...BEFORE.machine].sort());
  });

  it('DESKTOP_ONLY_TOOLS sale del catálogo con los mismos nombres que antes', () => {
    expect([...DESKTOP_ONLY_TOOLS].sort()).toEqual([...BEFORE.desktop].sort());
    expect(desktopOnlyToolNames().sort()).toEqual([...BEFORE.desktop].sort());
  });

  it('THREAD_ALLOW_TOOLS conserva nombres y orden', () => {
    expect(THREAD_ALLOW_TOOLS).toEqual(BEFORE.threadAllow);
    expect(threadAllowToolNames()).toEqual(BEFORE.threadAllow);
    expect(THREAD_ALLOW_TOOLS).toContain(LOADER_TOOL_NAME);
  });

  it('DEFERRED_DEFAULTS conserva claves, orden de carga y patrones', () => {
    expect(Object.keys(DEFERRED_DEFAULTS)).toEqual(BEFORE.deferred);
    expect(Object.keys(deferredSpecs())).toEqual(BEFORE.deferred);
    expect(DEFERRED_DEFAULTS.browser?.pattern.test('mira en booking.com')).toBe(true);
    expect(DEFERRED_DEFAULTS.media?.pattern.test('mándame una nota de voz')).toBe(true);
    expect(DEFERRED_DEFAULTS.delegate?.pattern.test('hazlo en paralelo')).toBe(true);
    expect(DEFERRED_DEFAULTS.browser?.pattern.test('¿qué tengo hoy?')).toBe(false);
  });

  it('ninguna herramienta que mueve la máquina es libre en los hilos', () => {
    for (const c of CAPABILITIES) {
      if (c.machine) expect(c.threadAllow, c.name).toBeFalsy();
    }
    for (const name of [
      'computer',
      'shell',
      'browser',
      'checkout',
      'write',
      'media',
      'tv',
      'windows',
    ]) {
      expect(THREAD_ALLOW_TOOLS).not.toContain(name);
    }
  });

  it('la auto-mejora no puede volver libre una herramienta desde el catálogo', () => {
    const diff = [
      'diff --git a/src/core/capabilities.ts b/src/core/capabilities.ts',
      '--- a/src/core/capabilities.ts',
      '+++ b/src/core/capabilities.ts',
      "+  { name: 'checkout', machine: true, threadAllow: true },",
    ].join('\n');
    expect(checkPatch(diff).some((v) => v.rule.includes('herramientas libres'))).toBe(true);
  });
});
