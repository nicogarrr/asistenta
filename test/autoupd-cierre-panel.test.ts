import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DAEMON_TASK_NAME, startDaemonTaskArgs } from '../src/autostart-watchdog.js';
import { daemonRunState } from '../src/autoupdate-cli.js';
import { DAEMON_EXIT_GRACE_MS } from '../src/controlled-daemon.js';
import { stopDaemon } from '../src/daemon-control.js';

/**
 * Autoactualización fallida del 2 nov (13:02): «Windows no llegó a abrir la versión nueva
 * en 300 s». Desde #1566 el panel web está encendido por defecto y su servidor HTTP no se
 * cerraba al parar: tras un cierre limpio el proceso node seguía vivo, run-hidden.ps1
 * seguía esperándolo, la tarea de Windows seguía «en ejecución» y Start-ScheduledTask
 * (IgnoreNew) no abría la versión nueva ni la vuelta atrás.
 *
 * Aquí se fija el camino entero que usa la autoactualización: qué orden relanza, cómo
 * sabe que la versión nueva está lista y que, tras parar, el proceso SALE de verdad.
 */
const SPAWN_MS = 60_000;
const linuxIt = process.platform === 'linux' ? it : it.skip;

function freePort(): Promise<number> {
  return new Promise((yes, no) => {
    const s = createServer();
    s.once('error', no);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => yes(port));
    });
  });
}

function exited(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((yes) => {
    const timer = setTimeout(() => yes(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      yes(true);
    });
  });
}

describe('autoactualización: relanzar y comprobar que la versión nueva arranca', () => {
  it('relanza por la tarea del daemon, el mismo camino que el vigilante', () => {
    const args = startDaemonTaskArgs();
    expect(args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
    ]);
    // Por su nombre, y si la tarea quedó «En ejecución» sin daemon se para antes (bugs22).
    expect(args[5]).toContain(
      `Get-ScheduledTask -TaskName '${DAEMON_TASK_NAME}' -ErrorAction Stop`,
    );
    expect(args[5]).toMatch(/\$t \| Start-ScheduledTask$/);
  });

  it('la tarea abre dist\\pa.js serve (o dist\\cli.js en una compilación vieja) y apunta «inicio de serve» antes', () => {
    const ps1 = readFileSync(resolve('deploy/windows/run-hidden.ps1'), 'utf8');
    expect(ps1).toContain("$cli = Join-Path $repo 'dist\\pa.js'");
    expect(ps1).toContain(
      "if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { $cli = Join-Path $repo 'dist\\cli.js' }",
    );
    expect(ps1).toContain(`$info.Arguments = '"' + $cli + '" serve'`);
    const mark = ps1.indexOf('inicio de serve (sin TTY)');
    expect(mark).toBeGreaterThan(0);
    expect(mark).toBeLessThan(ps1.indexOf('$process.Start()'));
    // La tarea solo queda libre para el siguiente Start-ScheduledTask cuando node termina.
    expect(ps1).toContain('$process.WaitForExit()');
  });

  linuxIt(
    'el daemon real (dist/pa.js serve, panel encendido) queda listo y SALE tras pa stop',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'pa-autoupd-'));
      const state = join(dir, 'state');
      mkdirSync(join(state, 'qa'), { recursive: true, mode: 0o700 });
      writeFileSync(join(state, 'qa', 'SANDBOX'), '');
      mkdirSync(join(dir, 'home'), { recursive: true });
      const env = {
        ...process.env,
        PA_STATE_DIR: state,
        PA_QA_CHANNEL: '1',
        PA_VAULT_BACKEND: 'portable',
        PA_DESKTOP: '0',
        PA_WEB_PORT: String(await freePort()),
        PA_SECRET_TELEGRAM_BOTTOKEN: '123456:fake-token-never-used',
        PA_SECRET_TELEGRAM_ALLOWEDUSERIDS: '4242',
        PA_SECRET_TELEGRAM_OWNERID: '4242',
        PA_SECRET_PROVIDER_APIKEY: 'fake',
        PA_API_KEY: 'fake',
        PA_PROVIDER_PRESET: 'openrouter',
        PA_BASE_URL: 'http://127.0.0.1:9/v1',
        PA_MODEL: 'test/model',
        HOME: join(dir, 'home'),
      };
      const child = spawn(
        process.execPath,
        ['--import', resolve('scripts/qa-daemon/preload.mjs'), resolve('dist/pa.js'), 'serve'],
        { env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let err = '';
      child.stderr?.on('data', (c) => {
        err = (err + c.toString()).slice(-4000);
      });
      try {
        // Lista = agent.pid escrito por el proceso vivo: lo que espera la autoactualización.
        const deadline = Date.now() + SPAWN_MS;
        while (Date.now() < deadline && daemonRunState(state) !== 'running') {
          if (child.exitCode !== null) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        expect(daemonRunState(state), err).toBe('running');
        expect(readFileSync(join(state, 'agent.pid'), 'utf8')).toContain(String(child.pid));

        const stop = spawnSync(process.execPath, [resolve('dist/pa.js'), 'stop'], {
          encoding: 'utf8',
          timeout: SPAWN_MS,
          env,
        });
        expect(stop.status, stop.stderr).toBe(0);
        expect(stop.stdout).toContain('Asistenta parada');
        // Antes seguía vivo para siempre (servidor del panel abierto) y Windows no podía
        // volver a lanzar la tarea.
        expect(await exited(child, 15_000), err).toBe(true);
        expect(child.exitCode).toBe(0);
        expect(existsSync(join(state, 'agent.pid'))).toBe(false);
        expect(daemonRunState(state)).toBe('stopped');
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await exited(child, 5_000);
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
    3 * SPAWN_MS,
  );

  linuxIt(
    'red de seguridad: algo olvidado abierto ya no deja el proceso vivo tras un cierre limpio',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'pa-autoupd-red-'));
      const lifecycle = pathToFileURL(resolve('dist/lifecycle.js')).href;
      const wrapper = pathToFileURL(resolve('dist/controlled-daemon.js')).href;
      // Un servidor que nadie cierra: lo mismo que hacía el panel web.
      const code = `import {installLifecycle} from ${JSON.stringify(lifecycle)};import {controlledDaemon} from ${JSON.stringify(wrapper)};import {createServer} from 'node:net';
        const leak=createServer();await new Promise(r=>leak.listen(0,'127.0.0.1',r));
        process.exitCode=await controlledDaemon(async ctl=>{const life=installLifecycle({name:'agent',shutdownBudgetMs:300,onShutdown:async()=>{}});ctl.attach(life);ctl.ready();console.log('ready');await life.done;return 0;});`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
        env: { ...process.env, PA_STATE_DIR: dir, PA_DESKTOP: 'off' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let err = '';
      child.stderr?.on('data', (c) => {
        err += c.toString();
      });
      try {
        await new Promise<void>((yes, no) => {
          const timer = setTimeout(() => no(new Error('fixture startup timeout')), SPAWN_MS);
          child.stdout?.on('data', (c) => {
            if (c.toString().includes('ready')) {
              clearTimeout(timer);
              yes();
            }
          });
          child.once('exit', () => no(new Error(`fixture exited before ready: ${err}`)));
        });
        await stopDaemon(dir);
        expect(await exited(child, DAEMON_EXIT_GRACE_MS + 10_000), err).toBe(true);
        expect(child.exitCode).toBe(0);
        expect(err).toMatch(/algo seguía abierto \(TCPServerWrap\b/);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await exited(child, 5_000);
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
    3 * SPAWN_MS,
  );
});
