import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error TS7016: módulo .mjs ejecutable, sin declaración de tipos.
import { configurarDeps } from '../scripts/windows-app/configurar.mjs';

const nsi = readFileSync('scripts/windows-app/asistenta.nsi', 'utf8');
const inst = nsi.slice(0, nsi.indexOf('Section "Uninstall"'));
const unin = nsi.slice(nsi.indexOf('Section "Uninstall"'));
const cli = '"$INSTDIR\\node\\node.exe" "$INSTDIR\\app\\dist\\cli.js"';

describe('instalador .exe: arrancar con Windows', () => {
  it('ofrece la casilla, marcada de serie (también sin ventanas)', () => {
    expect(nsi).toContain('"Arrancar Asistenta al encender el PC"');
    expect(nsi).toContain(`StrCpy $Arranque \${BST_CHECKED}`);
    expect(nsi).toContain(`\${NSD_SetState} $CasillaArranque $Arranque`);
  });

  it('usa el arranque automático de siempre, no uno nuevo', () => {
    const casilla = inst.slice(inst.indexOf(`\${If} $Arranque == \${BST_CHECKED}`));
    expect(casilla).toContain(`nsExec::ExecToLog '${cli} autostart install'`);
    expect(nsi).not.toMatch(/schtasks|Register-ScheduledTask|CurrentVersion\\Run"/i);
    expect(casilla).toContain(`CreateShortcut "$SMSTARTUP\\Asistenta.lnk" "$SYSDIR\\wscript.exe"`);
  });

  it('desinstalar quita el arranque con Windows y el icono', () => {
    expect(unin).toContain(`nsExec::Exec '${cli} autostart uninstall'`);
    expect(unin).toContain('Delete "$SMSTARTUP\\Asistenta.lnk"');
    const tray = readFileSync('scripts/windows-app/bandeja.ps1', 'utf8');
    expect(tray).toMatch(
      /if \(-not \(Test-Path -LiteralPath \$cli\)\) \{ \$icono\.Visible = \$false/,
    );
  });

  it('al terminar ofrece configurar (token y clave) con el Node de dentro', () => {
    expect(nsi).toContain('!define MUI_FINISHPAGE_RUN "$INSTDIR\\node\\node.exe"');
    expect(nsi).toMatch(/MUI_FINISHPAGE_RUN_PARAMETERS .*configurar\.mjs/);
    expect(inst).toContain('Configurar Asistenta.lnk');
  });
});

describe('Configurar Asistenta', () => {
  it('no descarga ni compila: npm no se lanza nunca', async () => {
    const run = vi.fn(async () => 7);
    const d = configurarDeps({ run, internet: async () => false }, 'C:\\A\\app');
    expect(await d.run('npm', ['ci'])).toBe(0);
    expect(await d.run('node', ['dist/cli.js'])).toBe(7);
    expect(run).toHaveBeenCalledTimes(1);
    expect(await d.npm()).toBe(true);
    expect(d.internet).toBeUndefined();
    expect(d.cwd).toBe('C:\\A\\app');
  });

  it('docs en castellano y aviso claro de SmartScreen', () => {
    const doc = readFileSync('docs/app-windows.md', 'utf8');
    expect(doc).toContain('SmartScreen');
    expect(doc).toContain('Ejecutar de todas formas');
    expect(readFileSync('README.md', 'utf8')).toContain('### Instalador .exe (recomendado)');
  });
});
