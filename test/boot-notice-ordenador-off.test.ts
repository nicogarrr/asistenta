import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type BootFacts, bootBanner } from '../src/boot-notice.js';
import { applySavedComputerOff, saveComputerSwitch } from '../src/screen/computer-switch.js';

/** La línea de arranque de la consola refleja un «/ordenador off» guardado. */
const dirs: string[] = [];
function stateDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'pa-boot-off-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Lo mismo que hace el daemon: aplicar lo guardado y luego construir los datos del aviso. */
function boot(config: { computerUse?: boolean }, dir: string, desktop = true): BootFacts {
  applySavedComputerOff(config, dir);
  return { tv: false, mail: false, computerUse: desktop && config.computerUse !== false };
}

describe('aviso de arranque y /ordenador off guardado', () => {
  it('con un off guardado, la consola dice «PC no»', () => {
    const dir = stateDir();
    saveComputerSwitch(dir, false);
    const config = { computerUse: true };
    expect(applySavedComputerOff(config, dir)).toBe(true);
    expect(config.computerUse).toBe(false);
    const facts = boot({ computerUse: true }, dir);
    expect(bootBanner(facts)).toContain('PC no');
  });

  it('sin nada guardado no cambia nada: «PC: sí»', () => {
    const dir = stateDir();
    const config = { computerUse: true };
    expect(applySavedComputerOff(config, dir)).toBe(false);
    expect(config.computerUse).toBe(true);
    expect(bootBanner(boot({}, dir))).toContain('PC sí');
  });

  it('tras /ordenador on el apagado deja de aplicarse', () => {
    const dir = stateDir();
    saveComputerSwitch(dir, false);
    saveComputerSwitch(dir, true);
    expect(bootBanner(boot({ computerUse: true }, dir))).toContain('PC sí');
  });

  it('PA_COMPUTER_USE=0 manda siempre: nada que aplicar y sigue «PC: no»', () => {
    const dir = stateDir();
    saveComputerSwitch(dir, false);
    const config = { computerUse: false };
    expect(applySavedComputerOff(config, dir)).toBe(false);
    expect(bootBanner(boot(config, dir))).toContain('PC no');
  });

  it('el daemon aplica lo guardado ANTES de construir el aviso, con la misma config', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const apply = src.indexOf('applySavedComputerOff(config, paths.state)');
    const notice = src.indexOf('bootBanner(facts)');
    expect(apply).toBeGreaterThan(0);
    expect(notice).toBeGreaterThan(apply);
    expect(src).toMatch(/computerUse: desktop && config\.computerUse !== false/);
  });
});
