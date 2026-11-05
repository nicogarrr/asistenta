import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { watchdogCommand, watchdogTaskXml } from '../src/autostart-watchdog.js';

// Consumo: la tarea del vigilante (cada 5 min, 24 h) lanzaba `node dist\cli.js`, que carga
// los ~900 módulos de Asistenta para leer un par de ficheros. Ahora va por `dist\pa.js` (la
// entrada mínima) y, si una vuelta atrás dejó una versión sin pa.js, cae a cli.js.
describe('consumo: vigilante por la entrada ligera', () => {
  it('la tarea prefiere dist\\pa.js y conserva cli.js como respaldo', () => {
    const { arguments: args } = watchdogCommand('C:\\node\\node.exe', 'C:\\a\\dist\\cli.js');
    expect(args).toContain("Test-Path -LiteralPath 'C:\\a\\dist\\pa.js'");
    expect(args).toContain("& 'C:\\node\\node.exe' 'C:\\a\\dist\\pa.js' autostart vigilar");
    expect(args).toContain(
      "else { & 'C:\\node\\node.exe' 'C:\\a\\dist\\cli.js' autostart vigilar }",
    );
    // Una sola cadena -Command entre comillas dobles: nada dentro las rompe.
    const cmd = args.slice(args.indexOf('-Command "') + 10);
    expect(cmd.endsWith('"')).toBe(true);
    expect(cmd.slice(0, -1)).not.toContain('"');
  });

  it('rutas con comilla simple y & siguen escapadas en el XML', () => {
    const xml = watchdogTaskXml({
      nodeExe: 'C:\\node\\node.exe',
      cliJs: "C:\\Users\\Nico's\\a&b\\dist\\cli.js",
    });
    expect(xml).toContain("Nico''s\\a&amp;b\\dist\\pa.js' autostart vigilar");
  });

  it('una entrada que no se llama cli.js se lanza tal cual', () => {
    const { arguments: args } = watchdogCommand('node.exe', 'C:\\a\\otro.js');
    expect(args).not.toContain('pa.js');
    expect(args).toContain("& 'node.exe' 'C:\\a\\otro.js' autostart vigilar");
  });

  // Con PowerShell instalado (CI o la caja de pruebas) se ejecuta el comando de verdad.
  const pwsh = ['pwsh', process.env.PA_TEST_PWSH ?? ''].find((p) => {
    if (!p) return false;
    try {
      execFileSync(p, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore', timeout: 20_000 });
      return true;
    } catch {
      return false;
    }
  });
  const root = mkdtempSync(join(tmpdir(), 'pa-consumo1-vig-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  it.skipIf(!pwsh || process.platform === 'win32')(
    'PowerShell elige pa.js si está y cli.js si no',
    () => {
      const dist = join(root, 'dist');
      mkdirSync(dist, { recursive: true });
      const fakeNode = join(root, 'node.sh');
      writeFileSync(fakeNode, `#!/bin/sh\necho "$1 $2 $3"\n`);
      chmodSync(fakeNode, 0o755);
      const run = () => {
        const { arguments: args } = watchdogCommand(fakeNode, join(dist, 'cli.js'));
        const script = args.slice(args.indexOf('-Command "') + 10, -1);
        return execFileSync(pwsh as string, ['-NoProfile', '-NonInteractive', '-Command', script], {
          encoding: 'utf8',
          timeout: 30_000,
        }).trim();
      };
      writeFileSync(join(dist, 'cli.js'), '');
      expect(existsSync(join(dist, 'pa.js'))).toBe(false);
      expect(run()).toBe(`${join(dist, 'cli.js')} autostart vigilar`);
      writeFileSync(join(dist, 'pa.js'), '');
      expect(run()).toBe(`${join(dist, 'pa.js')} autostart vigilar`);
    },
  );
});
