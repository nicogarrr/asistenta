import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  COMPUTER_OFF_FILE,
  type ComputerSwitchDeps,
  computerOffSaved,
  computerSwitchCommand,
} from '../src/screen/computer-switch.js';

/**
 * /ordenador estado dice si el «off» está guardado (sobrevive a un reinicio) o no.
 * Antes solo decía ACTIVADO/DESACTIVADO, y Nico no podía saber si al reiniciar el
 * asistente el control volvería a encenderse. Sin `offSaved` (otros usos), el texto
 * de siempre, sin cambios.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function deps(on: boolean, offSaved?: () => boolean): ComputerSwitchDeps {
  return { isOwner: true, enabled: () => on, set: () => {}, offSaved };
}

describe('/ordenador estado y el apagado guardado', () => {
  it('apagado y guardado en disco: dice que sigue apagado tras reiniciar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cu6-'));
    dirs.push(dir);
    writeFileSync(join(dir, COMPUTER_OFF_FILE), '{"off":true}\n');
    const out = computerSwitchCommand(
      'estado',
      deps(false, () => computerOffSaved(dir)),
    );
    expect(out).toMatch(/DESACTIVADO/);
    expect(out).toMatch(/El apagado está guardado: sigue apagado aunque se reinicie/);
  });

  it('apagado solo en memoria: avisa de que al reiniciar manda el .env', () => {
    const out = computerSwitchCommand(
      '',
      deps(false, () => false),
    );
    expect(out).toMatch(/El apagado no está guardado: al reiniciar vuelve a lo que diga el \.env/);
  });

  it('encendido con un apagado guardado que no se pudo borrar: lo avisa', () => {
    const out = computerSwitchCommand(
      'estado',
      deps(true, () => true),
    );
    expect(out).toMatch(/ACTIVADO/);
    expect(out).toMatch(/arrancará con el control apagado/);
  });

  it('encendido sin nada guardado, o sin offSaved: el texto de siempre', () => {
    const plain = '🖥️ Control del ordenador: ACTIVADO. Apágalo con /ordenador off.';
    expect(
      computerSwitchCommand(
        'estado',
        deps(true, () => false),
      ),
    ).toBe(plain);
    expect(computerSwitchCommand('estado', deps(true))).toBe(plain);
    expect(computerSwitchCommand('', deps(false))).toBe(
      '🛑 Control del ordenador: DESACTIVADO. Enciéndelo con /ordenador on.',
    );
  });

  it('si mirar el disco falla, lo dice sin romper el estado', () => {
    const out = computerSwitchCommand(
      'estado',
      deps(false, () => {
        throw new Error('EACCES');
      }),
    );
    expect(out).toMatch(/DESACTIVADO/);
    expect(out).toMatch(/No he podido mirar si el apagado está guardado/);
  });

  it('cli.ts conecta offSaved al fichero guardado', async () => {
    const { readFileSync } = await import('node:fs');
    const cli = readFileSync(join(__dirname, '../src/cli.ts'), 'utf8');
    expect(cli).toMatch(/offSaved: \(\) => computerOffSaved\(paths\.state\)/);
  });
});
