import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMPUTER_OFF_FILE,
  computerOffSaved,
  computerSwitchCommand,
  saveComputerSwitch,
} from '../src/screen/computer-switch.js';
import { STATE_ENTRIES } from '../src/state-files.js';

/**
 * /ordenador off sobrevive a un reinicio (solo más estricto). Antes el apagado
 * vivía en memoria: si el asistente se reiniciaba (Windows, caída, actualización)
 * el control del PC volvía a estar encendido sin que Nico lo pidiera.
 */
const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'pa-ordenador-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('saveComputerSwitch / computerOffSaved', () => {
  it('off se guarda en disco y on lo borra', () => {
    const dir = join(tmp(), 'state-nuevo');
    expect(computerOffSaved(dir)).toBe(false);
    saveComputerSwitch(dir, false);
    expect(computerOffSaved(dir)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, COMPUTER_OFF_FILE), 'utf8')).off).toBe(true);
    saveComputerSwitch(dir, true);
    expect(computerOffSaved(dir)).toBe(false);
    saveComputerSwitch(dir, true); // on sin fichero no falla
    expect(computerOffSaved(dir)).toBe(false);
  });

  it('está en el registro de ficheros de estado y entra en la copia', () => {
    const e = STATE_ENTRIES.find((x) => x.name === COMPUTER_OFF_FILE);
    expect(e?.backup).toBe('file');
  });
});

describe('/ordenador con save', () => {
  const deps = (save: (on: boolean) => void) => {
    let on = true;
    const set = vi.fn((v: boolean) => {
      on = v;
    });
    return { isOwner: true, enabled: () => on, set, save: vi.fn(save) };
  };

  it('off guardado: lo dice y no promete volver al .env', () => {
    const d = deps(() => {});
    const r = computerSwitchCommand('off', d);
    expect(d.set).toHaveBeenCalledWith(false);
    expect(d.save).toHaveBeenCalledWith(false);
    expect(r).toContain('Sigue apagado aunque se reinicie');
    expect(r).not.toContain('vuelve a lo que diga el .env');
  });

  it('off que no se puede guardar: sigue apagado ahora y avisa', () => {
    const d = deps(() => {
      throw new Error('EACCES');
    });
    const r = computerSwitchCommand('off', d);
    expect(d.set).toHaveBeenCalledWith(false);
    expect(d.enabled()).toBe(false);
    expect(r).toContain('No he podido guardarlo');
  });

  it('on que no puede borrar el apagado: avisa de que arrancará apagado', () => {
    const d = deps(() => {
      throw new Error('EBUSY');
    });
    const r = computerSwitchCommand('on', d);
    expect(d.set).toHaveBeenCalledWith(true);
    expect(r).toContain('arrancará con el control apagado');
  });

  it('quien no es el dueño no guarda nada', () => {
    const d = { ...deps(() => {}), isOwner: false };
    computerSwitchCommand('off', d);
    expect(d.set).not.toHaveBeenCalled();
    expect(d.save).not.toHaveBeenCalled();
  });
});

describe('cableado en el daemon', () => {
  const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  it('arranca apagado si hay un off guardado (el .env=0 sigue mandando)', () => {
    // applySavedComputerOff respeta PA_COMPUTER_USE=0 (test/boot-notice-ordenador-off.test.ts).
    expect(cli).toContain('applySavedComputerOff(config, paths.state)');
  });
  it('/ordenador guarda la elección', () => {
    expect(cli).toContain('save: (on) => saveComputerSwitch(paths.state, on)');
  });
});
