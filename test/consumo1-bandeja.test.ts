import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// Consumo: la bandeja lanzaba un node completo (`pa status --json`) cada minuto, 24 h al
// día, también con todo en verde. Ahora, si el latido y el estado de Telegram que escribe
// el daemon son recientes y su proceso vive, decide «verde» leyendo esos tres ficheros;
// ante cualquier duda pregunta a pa status como siempre.
const tray = readFileSync('scripts/windows-app/bandeja.ps1', 'utf8');
const fnStart = tray.indexOf('$frescoMs = ');
const fnEnd = tray.indexOf('\n}\n', tray.indexOf('function Read-VerdeSinNode')) + 3;
const atajo = tray.slice(fnStart, fnEnd);

describe('consumo: bandeja sin lanzar node cuando todo está bien', () => {
  it('Get-Estado prueba el atajo antes de lanzar pa status', () => {
    expect(fnStart).toBeGreaterThan(0);
    const fn = tray.slice(
      tray.indexOf('function Get-Estado {'),
      tray.indexOf('\n}\n', tray.indexOf('function Get-Estado {')),
    );
    expect(fn.indexOf('Read-VerdeSinNode')).toBeGreaterThan(0);
    expect(fn.indexOf('Read-VerdeSinNode')).toBeLessThan(fn.indexOf('Invoke-Pa'));
  });

  it('el atajo solo dice verde y es más estricto que pa status (45 s < 2 min)', () => {
    expect(atajo).toContain('$frescoMs = 45000');
    expect(atajo).not.toMatch(/return 'ambar'|return 'rojo'/);
    expect(atajo).toContain('} catch { return $null }');
    // Solo lee los tres ficheros de estado: nada de .env, claves ni token del panel.
    expect(atajo).not.toMatch(/\.env|token|vault|secret/i);
    expect(atajo).not.toMatch(/Invoke-Pa|Start-Process|node/);
  });

  const pwsh = ['pwsh', process.env.PA_TEST_PWSH ?? ''].find((p) => {
    if (!p) return false;
    try {
      execFileSync(p, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore', timeout: 20_000 });
      return true;
    } catch {
      return false;
    }
  });
  const root = mkdtempSync(join(tmpdir(), 'pa-consumo1-bandeja-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const run = (files: Record<string, string | null>): string => {
    const dir = mkdtempSync(join(root, 's-'));
    for (const [name, body] of Object.entries(files))
      if (body !== null) writeFileSync(join(dir, name), body);
    const script = `$stateDir = '${dir}'\n${atajo}\n$r = Read-VerdeSinNode\nif ($r) { $r } else { 'NULL' }`;
    return execFileSync(pwsh as string, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 30_000,
    }).trim();
  };
  const ok = () => ({
    'agent.heartbeat': `${Date.now() - 5_000}\n`,
    'telegram.estado': `1 ${Date.now() - 5_000}\n`,
    'agent.pid': `${process.pid}\n`,
  });

  it.skipIf(!pwsh)('PowerShell: verde con latido y Telegram recientes y el proceso vivo', () => {
    expect(run(ok())).toBe('verde');
  });

  it.skipIf(!pwsh)('PowerShell: cualquier duda vuelve a pa status (null)', () => {
    expect(run({ ...ok(), 'agent.heartbeat': `${Date.now() - 60_000}\n` })).toBe('NULL');
    expect(run({ ...ok(), 'telegram.estado': `0 ${Date.now()}\n` })).toBe('NULL');
    expect(run({ ...ok(), 'telegram.estado': `1 ${Date.now() - 50_000}\n` })).toBe('NULL');
    expect(run({ ...ok(), 'agent.pid': '999999999\n' })).toBe('NULL');
    expect(run({ ...ok(), 'agent.pid': null })).toBe('NULL');
    expect(run({ ...ok(), 'agent.heartbeat': 'basura' })).toBe('NULL');
    expect(run({ ...ok(), 'agent.heartbeat': `${Date.now() + 60_000}\n` })).toBe('NULL');
  });
});
