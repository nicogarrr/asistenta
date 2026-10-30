import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Gate, onDiskSpelling } from '../src/permissions.js';

/**
 * Las comprobaciones de rutas protegidas eran solo léxicas: otra grafía en disco del
 * mismo fichero (enlace simbólico o unión; en Windows también nombres cortos 8.3 como
 * PROGRA~1) pasaba como un fichero distinto. Ahora cuenta también la ruta real.
 */
describe('rutas protegidas: la grafía en disco también cuenta', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-ondisk-'));
  const real = join(dir, 'real');
  mkdirSync(real);
  writeFileSync(join(real, 'cli.ts'), 'x');
  const link = join(dir, 'enlace');
  symlinkSync(real, link, 'dir');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const ask = () => false;

  it('escribir por un enlace a una carpeta protegida se trata igual que la ruta real', async () => {
    const gate = new Gate({ grantWindowMs: 0, protectedPaths: [real], approver: ask });
    const direct = await gate.check('s', {
      tool: 'write',
      args: { path: join(real, 'cli.ts'), content: 'y' },
      actor: 'local',
    });
    const viaLink = await gate.check('s', {
      tool: 'write',
      args: { path: join(link, 'cli.ts'), content: 'y' },
      actor: 'local',
    });
    expect(direct.verdict).not.toBe('allow');
    expect(viaLink.verdict).toBe(direct.verdict);
    expect(viaLink.reason).toBe(direct.reason);
  });

  it('un fichero nuevo bajo el enlace también cuenta (ancestro existente + resto)', async () => {
    const gate = new Gate({ grantWindowMs: 0, protectedPaths: [real], approver: ask });
    const d = await gate.check('s', {
      tool: 'write',
      args: { path: join(link, 'nuevo', 'a.ts'), content: 'y' },
      actor: 'local',
    });
    expect(d.verdict).not.toBe('allow');
  });

  it('una carpeta no protegida sigue igual', async () => {
    const other = join(dir, 'otra');
    mkdirSync(other);
    const gate = new Gate({ grantWindowMs: 0, protectedPaths: [real], approver: () => true });
    const d = await gate.check('s', {
      tool: 'write',
      args: { path: join(other, 'a.ts'), content: 'y' },
      actor: 'local',
    });
    expect(d.verdict).toBe('allow');
  });

  it('onDiskSpelling resuelve el ancestro existente y conserva el resto', () => {
    expect(onDiskSpelling(join(link, 'no', 'existe.txt'))).toBe(
      join(onDiskSpelling(real) ?? '', 'no', 'existe.txt'),
    );
    expect(onDiskSpelling('relativa/x')).toBeNull();
  });
});
