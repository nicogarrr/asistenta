import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// La bandeja pregunta `pa status --json` cada minuto y el vigilante corre `pa autostart`
// cada 5 min. Por dist/pa.js esas dos órdenes ya no cargan cli.ts (~900 módulos): misma
// función, misma salida, sin el resto de Asistenta.

const dir = mkdtempSync(join(tmpdir(), 'pa-energia1-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Avisa por stderr si algo resuelve dist/cli.js: así se ve qué orden carga todo Asistenta.
const HOOK = `data:text/javascript,${encodeURIComponent(
  "import { registerHooks } from 'node:module';" +
    'registerHooks({ resolve(s, c, next) { const r = next(s, c);' +
    " if (r.url.endsWith('/dist/cli.js')) process.stderr.write('CLI_CARGADO\\n'); return r; } });",
)}`;

function run(entry: 'pa' | 'cli', args: string[]) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PA_STATE_DIR: dir,
    PA_TIMEZONE: 'Europe/Madrid',
  };
  delete env.NODE_COMPILE_CACHE;
  const r = spawnSync(process.execPath, ['--import', HOOK, resolve(`dist/${entry}.js`), ...args], {
    encoding: 'utf8',
    env,
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout, cli: r.stderr.includes('CLI_CARGADO'), err: r.stderr };
}

describe('energia1: órdenes ligeras por dist/pa.js', () => {
  it('pa status --json: mismo JSON que por cli.js, sin cargar cli.js', () => {
    // Un daemon «vivo» de mentira: este mismo proceso como PID, latido fresco y Telegram conectada.
    const now = Date.now();
    writeFileSync(join(dir, 'agent.pid'), `${process.pid}\n`);
    writeFileSync(join(dir, 'agent.heartbeat'), String(now));
    writeFileSync(join(dir, 'telegram.estado'), `1 ${now}\n`);
    const ligero = run('pa', ['status', '--json']);
    const completo = run('cli', ['status', '--json']);
    expect(ligero.cli, ligero.err).toBe(false);
    expect(completo.cli).toBe(true);
    expect(ligero.code).toBe(completo.code);
    const a = JSON.parse(ligero.out);
    const b = JSON.parse(completo.out);
    // La edad del latido depende del instante de cada lanzamiento; el resto, idéntico.
    for (const k of ['ageMs']) {
      delete a[k];
      delete b[k];
    }
    expect(a).toEqual(b);
    expect(a.processState).toBe('alive');
    expect(a.heartbeatState).toBe('fresh');
    expect(a.telegram).toBe('conectada');
  });

  it('pa status (texto) y pa autostart: misma salida y código que por cli.js', () => {
    rmSync(join(dir, 'agent.pid'), { force: true });
    for (const args of [['status'], ['autostart'], ['autostart', 'status']]) {
      const ligero = run('pa', args);
      const completo = run('cli', args);
      expect(ligero.cli, args.join(' ')).toBe(false);
      expect(ligero.code, args.join(' ')).toBe(completo.code);
      expect(ligero.out.replace(/\d+ s\b/g, 'N s'), args.join(' ')).toBe(
        completo.out.replace(/\d+ s\b/g, 'N s'),
      );
    }
  });

  it('el resto de órdenes sigue por cli.js', () => {
    const r = run('pa', ['--version']);
    expect(r.cli).toBe(true);
    expect(r.code).toBe(run('cli', ['--version']).code);
  });

  it('la bandeja pregunta por dist\\pa.js y, si una versión vieja no lo trae, por cli.js', () => {
    const tray = readFileSync('scripts/windows-app/bandeja.ps1', 'utf8');
    const fn = tray.slice(
      tray.indexOf('function Invoke-Pa'),
      tray.indexOf('\n}\n', tray.indexOf('function Invoke-Pa')),
    );
    expect(fn).toContain("$entrada = Join-Path $app 'dist\\pa.js'");
    expect(fn).toContain('if (-not (Test-Path -LiteralPath $entrada)) { $entrada = $cli }');
    expect(fn).toContain(`$psi.Arguments = '"' + $entrada + '" ' + ($Orden -join ' ')`);
    // «Desinstalada» se sigue decidiendo por cli.js, que siempre está.
    expect(tray).toContain("$cli = Join-Path $app 'dist\\cli.js'");
    expect(tray).toContain('if (-not (Test-Path -LiteralPath $cli)) { $icono.Visible = $false');
  });
});
