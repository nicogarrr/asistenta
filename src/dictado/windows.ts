/**
 * Piezas de Windows del dictado. La tecla se vigila con un PowerShell que mira
 * GetAsyncKeyState cada 30 ms y escribe «D» al pulsar la combinación entera y
 * «U» cuando ya no queda ninguna de sus teclas pulsada (así nunca se escribe
 * con Ctrl todavía apretado). El mismo proceso pita al empezar y al acabar.
 * El texto se escribe con el mismo camino que Computer Use (WindowsScreen.type).
 */

import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { childEnv } from '../child-env.js';
import { WindowsScreen } from '../screen/windows.js';
import type { Aviso, EscritorDictado, TeclaDictado } from './tipos.js';

/** Script del vigilante de la tecla. Cada grupo vale si cualquiera de sus códigos está pulsado. */
export function scriptTecla(teclas: number[][], pidPadre: number): string {
  const grupos = teclas.map((g) => g.join(',')).join(';');
  return `$ErrorActionPreference='Stop'
Add-Type -Namespace PaDict -Name K -MemberDefinition '[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);'
$g='${grupos}'.Split(';'); $down=$false; $n=0
while ($true) {
  $todas=$true; $ninguna=$true
  foreach ($grp in $g) { $una=$false
    foreach ($v in $grp.Split(',')) { if (([PaDict.K]::GetAsyncKeyState([int]$v) -band 0x8000) -ne 0) { $una=$true } }
    if ($una) { $ninguna=$false } else { $todas=$false } }
  if (-not $down -and $todas) { $down=$true; [Console]::Out.WriteLine('D'); [Console]::Out.Flush(); [Console]::Beep(880,70) }
  elseif ($down -and $ninguna) { $down=$false; [Console]::Out.WriteLine('U'); [Console]::Out.Flush(); [Console]::Beep(620,70) }
  if ((++$n % 60) -eq 0 -and -not (Get-Process -Id ${pidPadre} -ErrorAction SilentlyContinue)) { exit }
  Start-Sleep -Milliseconds 30
}`;
}

type Lanzar = (script: string) => ChildProcess;
const lanzarPs: Lanzar = (script) =>
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: childEnv(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });

export class TeclaWindows implements TeclaDictado {
  #hijo: ChildProcess | null = null;
  readonly #teclas: number[][];
  readonly #lanzar: Lanzar;
  constructor(teclas: number[][], lanzar: Lanzar = lanzarPs) {
    this.#teclas = teclas;
    this.#lanzar = lanzar;
  }

  async start(alPulsar: () => void, alSoltar: () => void): Promise<void> {
    if (this.#hijo) return;
    const hijo = this.#lanzar(scriptTecla(this.#teclas, process.pid));
    this.#hijo = hijo;
    let resto = '';
    hijo.stdout?.on('data', (b: Buffer) => {
      const lineas = (resto + b.toString('utf8')).split(/\r?\n/);
      resto = lineas.pop() ?? '';
      for (const l of lineas) {
        if (l.trim() === 'D') alPulsar();
        else if (l.trim() === 'U') alSoltar();
      }
    });
    hijo.on('exit', () => {
      if (this.#hijo === hijo) this.#hijo = null;
    });
  }

  async stop(): Promise<void> {
    this.#hijo?.kill();
    this.#hijo = null;
  }
}

/** UI Automation dice si el control con el foco es de contraseña. */
export const SCRIPT_CAMPO_SEGURO = `Add-Type -AssemblyName UIAutomationClient
$e=[System.Windows.Automation.AutomationElement]::FocusedElement
if ($null -ne $e -and $e.Current.IsPassword) { 'SI' } else { 'NO' }`;

type Ps = (script: string) => Promise<string>;
const ps: Ps = (script) =>
  new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { env: childEnv(), timeout: 5000, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });

export function escritorWindows(
  correr: Ps = ps,
  pantalla: { type(t: string): Promise<void> } = new WindowsScreen(),
): EscritorDictado {
  return {
    campoSeguro: async () => (await correr(SCRIPT_CAMPO_SEGURO)).includes('SI'),
    escribir: (texto) => pantalla.type(texto),
  };
}

/** «graba» y «fin» ya pitan desde el vigilante; «no» son dos pitidos graves. */
export function avisarWindows(a: Aviso, correr: Ps = ps): void {
  if (a === 'no') void correr('[Console]::Beep(330,120); [Console]::Beep(330,120)').catch(() => {});
}
