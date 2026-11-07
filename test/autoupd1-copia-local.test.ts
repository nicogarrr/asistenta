import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AutoupdateDeps, planUpdate, runAutoupdate } from '../src/autoupdate.js';
import { movePathsAside } from '../src/autoupdate-cli.js';

// Nico, 6 nov: su copia tenía un commit local que ya venía en main (fusionado como squash,
// otro SHA) y la autoactualización se negaba («cambios propios»). Ahora lo reconoce por
// contenido, guarda el commit en una rama y vuelve a origin/main; los archivos sueltos que
// la versión nueva pisaría se apartan a una copia, nunca se borran.

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-autoupd1-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Opts {
  dirty?: string;
  ancestor?: boolean;
  cherry?: string;
  mergeTree?: { code: number; out: string };
  untracked?: string[];
  incoming?: string[];
  build?: number;
}

function fake(o: Opts = {}) {
  const calls: string[] = [];
  const sent: string[] = [];
  const steps: string[] = [];
  const moved: string[][] = [];
  let restored = 0;
  let state: 'running' | 'stopped' = 'running';
  let t = Date.parse('2026-11-07T13:00:00Z');
  const git: AutoupdateDeps['git'] = async (args) => {
    const cmd = args.join(' ');
    calls.push(`git ${cmd}`);
    if (cmd === 'rev-parse --abbrev-ref HEAD') return { code: 0, out: 'main\n' };
    if (cmd === 'rev-parse HEAD') return { code: 0, out: `${OLD}\n` };
    if (cmd === 'rev-parse origin/main') return { code: 0, out: `${NEW}\n` };
    if (cmd === `rev-parse ${NEW}^{tree}`) return { code: 0, out: `${TREE}\n` };
    if (args[0] === 'status') return { code: 0, out: o.dirty ?? '' };
    if (args[0] === 'merge-base') return { code: o.ancestor === false ? 1 : 0, out: '' };
    if (args[0] === 'cherry') return { code: 0, out: o.cherry ?? '' };
    if (args[0] === 'merge-tree') return o.mergeTree ?? { code: 1, out: 'CONFLICT' };
    if (args[0] === 'ls-files')
      return { code: 0, out: (o.untracked ?? []).map((f) => `${f}\0`).join('') };
    if (args[0] === 'ls-tree')
      return { code: 0, out: (o.incoming ?? ['src/a.ts']).map((f) => `${f}\0`).join('') };
    if (args[0] === 'log') return { code: 0, out: 'fix: algo (#1)\n' };
    return { code: 0, out: '' };
  };
  const deps: AutoupdateDeps = {
    git,
    npm: async (args) => {
      calls.push(`npm ${args.join(' ')}`);
      return { code: args[0] === 'run' ? (o.build ?? 0) : 0, out: '' };
    },
    daemonState: () => state,
    busy: () => 'libre',
    stopDaemon: async () => {
      calls.push('stop');
      state = 'stopped';
    },
    startDaemon: async () => {
      calls.push('start');
      state = 'running';
      return true;
    },
    backupDist: () => {},
    restoreDist: () => {},
    dropBackup: () => {},
    notify: async (text) => {
      sent.push(text);
    },
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
    logStep: (line) => steps.push(line),
    moveAside: (paths) => {
      moved.push(paths);
      return {
        dir: 'C:\\copia',
        restore: () => {
          restored++;
        },
      };
    },
  };
  return { deps, git, calls, sent, steps, moved, restored: () => restored };
}

describe('planUpdate: qué hacer con la copia local', () => {
  it('fast-forward limpio', async () => {
    const plan = await planUpdate(fake().git, OLD, NEW);
    expect(plan).toEqual({ action: 'ff', aside: [], discardLock: false, dupCommits: 0 });
  });

  it('commits locales ya en origin/main por patch-id (git cherry «-»): reset', async () => {
    const f = fake({ ancestor: false, cherry: `- ${'d'.repeat(40)}\n- ${'e'.repeat(40)}\n` });
    const plan = await planUpdate(f.git, OLD, NEW);
    expect(plan).toMatchObject({ action: 'reset', dupCommits: 2 });
  });

  it('commit de merge de un git pull ya contenido (mismo árbol al fusionar): reset', async () => {
    const f = fake({
      ancestor: false,
      cherry: `+ ${'d'.repeat(40)}\n`,
      mergeTree: { code: 0, out: `${TREE}\n` },
    });
    expect((await planUpdate(f.git, OLD, NEW)).action).toBe('reset');
  });

  it('cambios locales de verdad (commit propio que no está arriba): no toca nada', async () => {
    const f = fake({
      ancestor: false,
      cherry: `- ${'d'.repeat(40)}\n+ ${'e'.repeat(40)}\n`,
      mergeTree: { code: 0, out: `${'f'.repeat(40)}\n` },
    });
    expect(await planUpdate(f.git, OLD, NEW)).toEqual({ action: 'refuse', reason: 'divergida' });
  });

  it('archivos con cambios sin guardar: no toca nada', async () => {
    const f = fake({ dirty: ' M src/cli.ts\n M package-lock.json\n' });
    expect(await planUpdate(f.git, OLD, NEW)).toEqual({
      action: 'refuse',
      reason: 'cambios-locales',
    });
  });

  it('solo package-lock.json tocado (npm install): se aparta y se reinstala', async () => {
    const f = fake({ dirty: ' M package-lock.json\n' });
    expect(await planUpdate(f.git, OLD, NEW)).toMatchObject({ action: 'ff', discardLock: true });
  });

  it('sueltos: solo se apartan los que la versión nueva trae (sin mirar mayúsculas)', async () => {
    const f = fake({
      untracked: ['src/voz-arreglo.ts', 'Notas.md', 'borrador.txt'],
      incoming: ['src/voz-arreglo.ts', 'notas.md', 'src/a.ts'],
    });
    const plan = await planUpdate(f.git, OLD, NEW);
    expect(plan).toMatchObject({ action: 'ff', aside: ['src/voz-arreglo.ts', 'Notas.md'] });
  });
});

describe('runAutoupdate con la copia del 6 de noviembre', () => {
  it('commit ya arriba + suelto: guarda rama, aparta, reset a origin/main, ci, build', async () => {
    const f = fake({
      ancestor: false,
      cherry: `- ${'d'.repeat(40)}\n`,
      untracked: ['src/voz-arreglo.ts'],
      incoming: ['src/voz-arreglo.ts'],
    });
    const out = await runAutoupdate(dir, f.deps, { env: {} });
    expect(out.kind).toBe('actualizada');
    expect(f.moved).toEqual([['src/voz-arreglo.ts']]);
    const i = (c: string) => f.calls.findIndex((x) => x.startsWith(c));
    expect(i('stop')).toBeLessThan(i('git branch -f copia-local-'));
    expect(i('git branch -f copia-local-')).toBeLessThan(i(`git reset --keep ${NEW}`));
    expect(i(`git reset --keep ${NEW}`)).toBeLessThan(i('npm run build'));
    expect(f.calls).not.toContain(`git merge --ff-only --quiet ${NEW}`);
    expect(f.sent.join('\n')).toContain('rama copia-local-');
    expect(f.sent.join('\n')).toContain('C:\\copia');
    expect(f.steps.some((s) => s.startsWith('plan: reset'))).toBe(true);
    expect(f.steps).toContain('arrancada y sana');
  });

  it('package-lock.json tocado: lo aparta, lo restaura de git y hace npm ci', async () => {
    const f = fake({ dirty: ' M package-lock.json\n' });
    const out = await runAutoupdate(dir, f.deps, { env: {} });
    expect(out.kind).toBe('actualizada');
    expect(f.moved).toEqual([['package-lock.json']]);
    expect(f.calls).toContain('git checkout -- package-lock.json');
    expect(f.calls).toContain('npm ci --no-audit --no-fund');
  });

  it('si la build falla vuelve al commit de antes y devuelve los apartados', async () => {
    const f = fake({ untracked: ['x.md'], incoming: ['x.md'], build: 1 });
    const out = await runAutoupdate(dir, f.deps, { env: {} });
    expect(out.kind).toBe('revertida');
    expect(f.calls).toContain(`git reset --keep ${OLD}`);
    expect(f.restored()).toBe(1);
    expect(f.steps.some((s) => s.startsWith('fallo:'))).toBe(true);
  });

  it('cambios de verdad: no para Asistenta ni toca git', async () => {
    const f = fake({ dirty: ' M src/cli.ts\n' });
    const out = await runAutoupdate(dir, f.deps, { env: {} });
    expect(out.text).toContain('cambios locales');
    expect(f.calls).not.toContain('stop');
    expect(f.calls.some((c) => /reset|merge --ff|checkout/.test(c))).toBe(false);
  });
});

describe('movePathsAside', () => {
  it('mueve sin borrar y restore los devuelve', () => {
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'x.ts'), 'hola');
    const m = movePathsAside(repo, join(dir, 'estado'), ['src/x.ts', 'no-existe.md']);
    expect(existsSync(join(repo, 'src', 'x.ts'))).toBe(false);
    expect(readFileSync(join(m.dir, 'src', 'x.ts'), 'utf8')).toBe('hola');
    m.restore();
    expect(readFileSync(join(repo, 'src', 'x.ts'), 'utf8')).toBe('hola');
  });
});

describe('planUpdate con git de verdad (repo temporal)', () => {
  const sh = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const runner =
    (cwd: string): AutoupdateDeps['git'] =>
    async (args) => {
      try {
        return { code: 0, out: sh(cwd, ...args) };
      } catch (e) {
        return { code: 1, out: String((e as { stderr?: string }).stderr ?? e) };
      }
    };
  const id = ['-c', 'user.email=t@t', '-c', 'user.name=t'];

  it('arreglo local fusionado arriba como squash junto a más cambios: reset; uno propio: refuse', async () => {
    const up = join(dir, 'up');
    mkdirSync(up);
    sh(up, 'init', '-q', '-b', 'main');
    writeFileSync(join(up, 'a.txt'), '1\n');
    sh(up, 'add', '-A');
    sh(up, ...id, 'commit', '-qm', 'base');
    const loc = join(dir, 'loc');
    sh(dir, 'clone', '-q', up, loc);
    writeFileSync(join(loc, 'a.txt'), '1\nfix\n');
    sh(loc, ...id, 'commit', '-qam', 'arreglo local');
    writeFileSync(join(up, 'a.txt'), '1\nfix\n');
    writeFileSync(join(up, 'b.txt'), 'nuevo\n');
    sh(up, 'add', '-A');
    sh(up, ...id, 'commit', '-qm', 'arreglo (#1) + más');
    sh(loc, 'fetch', '-q', 'origin');
    writeFileSync(join(loc, 'b.txt'), 'borrador\n');
    const git = runner(loc);
    const head = sh(loc, 'rev-parse', 'HEAD').trim();
    const remote = sh(loc, 'rev-parse', 'origin/main').trim();
    expect(await planUpdate(git, head, remote)).toMatchObject({
      action: 'reset',
      aside: ['b.txt'],
    });

    writeFileSync(join(loc, 'c.txt'), 'mío\n');
    sh(loc, 'add', 'c.txt');
    sh(loc, ...id, 'commit', '-qm', 'cambio propio');
    const head2 = sh(loc, 'rev-parse', 'HEAD').trim();
    expect(await planUpdate(git, head2, remote)).toEqual({ action: 'refuse', reason: 'divergida' });
  });
});
