import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ps1 = readFileSync('scripts/windows-app/bandeja.ps1');
const tray = ps1.toString('utf8');
const vbs = readFileSync('scripts/windows-app/asistenta.vbs', 'utf8');
const nsi = readFileSync('scripts/windows-app/asistenta.nsi', 'utf8');

/** Cuerpo del clic de una opción del menú: desde su add_Click hasta la siguiente opción. */
function clic(variable: string): string {
  const i = tray.indexOf(`$${variable}.add_Click(`);
  expect(i, variable).toBeGreaterThan(0);
  return tray.slice(i, tray.indexOf('\n})', i));
}

describe('icono de la bandeja', () => {
  it('menú en castellano llano con las seis opciones', () => {
    for (const o of [
      'Abrir panel',
      'Pausar / Reanudar',
      'Reiniciar',
      'Ver estado',
      'Ver registro',
      'Salir',
    ])
      expect(tray).toContain(`.Items.Add('${o}')`);
    expect(tray).toContain("'Pausar' } else { 'Reanudar' }");
  });

  it('cada opción usa solo órdenes de pa', () => {
    expect(tray).toMatch(/Estado\s+= @\('status', '--json'\)/);
    expect(tray).toMatch(/Texto\s+= @\('status'\)/);
    expect(tray).toMatch(/Pausar\s+= @\('stop'\)/);
    expect(tray).toMatch(/Encender = @\('iniciar'\)/);
    expect(clic('pausa')).toMatch(/Invoke-Pa \$Ordenes\.Pausar[\s\S]*Start-Asistenta/);
    expect(clic('reiniciar')).toMatch(/Invoke-Pa \$Ordenes\.Pausar[\s\S]*Start-Asistenta/);
    expect(clic('estado')).toContain('Invoke-Pa $Ordenes.Texto');
    expect(clic('salir')).toMatch(/Invoke-Pa \$Ordenes\.Pausar[\s\S]*Application\]::Exit/);
    expect(clic('registro')).toContain("Join-Path $stateDir 'log'");
  });

  it('verde solo si está viva, dando señales y conectada a Telegram; si no, ámbar o rojo', () => {
    expect(tray).toContain("$s.processState -eq 'alive' -and $s.heartbeatState -eq 'fresh'");
    const fn = tray.slice(
      tray.indexOf('function Get-Estado'),
      tray.indexOf('\n}\n', tray.indexOf('function Get-Estado')),
    );
    expect(fn).toMatch(/catch \{ return 'rojo' \}/);
    expect(fn).toMatch(/'fresh'\)\) \{ return 'rojo' \}/);
    expect(fn).toMatch(/\$s\.telegram -eq 'conectada'\) \{ return 'verde' \}\s*return 'ambar'/);
    expect(tray).toContain("'ambar' { 'Asistenta: en marcha, sin Telegram' }");
    expect(tray).toContain("$script:enMarcha = $script:color -ne 'rojo'");
    expect(clic('estado')).toContain('🟡 En marcha, pero sin conexión con Telegram');
  });

  it('panel: lo abre pa panel (ya con token); la bandeja no lee ni pasa el token', () => {
    expect(tray).toMatch(/Panel\s+= @\('panel'\)/);
    expect(clic('abrir')).toContain('Invoke-Pa $Ordenes.Panel');
    expect(clic('abrir')).toContain('Show-Aviso $r.Text');
    expect(tray).not.toMatch(/PA_WEB_TOKEN\s*=|token=|vault/i);
    expect(tray.match(/https?:\/\/[^\s"']+/g)).toBeNull();
  });

  it('las órdenes van sin ventana de consola', () => {
    expect(tray).toContain('$psi.CreateNoWindow = $true');
    expect(tray).toContain('$psi.UseShellExecute = $false');
    expect(tray).toMatch(/Start-Process -FilePath \$node .* -WindowStyle Hidden/);
    expect(tray).not.toMatch(/WindowStyle (Normal|Maximized)/);
  });

  it('reutiliza la tarea del arranque automático, no crea otra', () => {
    expect(tray).toContain("$tarea = 'personal-agent-daemon'");
    expect(tray).not.toMatch(/Register-ScheduledTask|schtasks(\.exe)? \/Create/i);
  });

  it('gancho del dictado: solo mira si existe el archivo', () => {
    expect(tray).toContain("Join-Path $stateDir 'dictado.grabando'");
    expect(tray).not.toMatch(/Get-Content[^\n]*grabando/);
  });

  it('lleva BOM UTF-8 (PowerShell 5.1)', () => {
    expect([...ps1.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });
});

describe('lanzador oculto', () => {
  it('abre el icono sin consola: ventana oculta y sin esperar', () => {
    expect(vbs).toMatch(
      /sh\.Run "powershell\.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File .*bandeja\.ps1""", 0, False/,
    );
    expect(vbs).not.toMatch(/cmd(\.exe)? \/[ck]|pause/i);
  });

  it('el menú Inicio lo abre con wscript (sin consola)', () => {
    expect(nsi).toContain(
      `CreateShortcut "$SMPROGRAMS\\Asistenta\\Asistenta.lnk" "$SYSDIR\\wscript.exe" '"$INSTDIR\\app\\scripts\\windows-app\\asistenta.vbs"'`,
    );
  });
});
