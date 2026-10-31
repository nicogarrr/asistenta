import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { batteryRunnerFromEnv, proposerEnv, proposerFromEnv } from '../src/evolve/run.js';

// El proponedor y el evaluador son código que no es del kernel. Sin HOME en su entorno,
// os.homedir() cae a la carpeta real del usuario (passwd en Linux, el perfil en Windows),
// y con ella a la carpeta de estado de Asistenta (~/.local/share/personal-agent), el
// almacén y la config. Ahora reciben una carpeta personal temporal, como la medición.

const REAL = homedir();

describe('proponedor y evaluador: carpeta personal temporal', () => {
  it('proposerEnv con home: HOME, USERPROFILE y APPDATA apuntan a la temporal', () => {
    const home = join(tmpdir(), 'h');
    const env = proposerEnv({ PATH: '/bin', HOME: '/home/real', APPDATA: 'C:\\real' }, home);
    expect(env.HOME).toBe(home);
    expect(env.USERPROFILE).toBe(home);
    expect(env.APPDATA).toBe(join(home, 'AppData', 'Roaming'));
    expect(JSON.stringify(env)).not.toContain('/home/real');
  });

  it('el operador puede pasar su HOME a propósito con PA_EVOLVE_PROPOSER_PASS', () => {
    const env = proposerEnv(
      { PATH: '/bin', HOME: '/home/real', PA_EVOLVE_PROPOSER_PASS: 'HOME' },
      join(tmpdir(), 'h'),
    );
    expect(env.HOME).toBe('/home/real');
  });

  it('el evaluador no ve la carpeta personal real y la temporal se borra', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pa-battery-home-'));
    mkdirSync(join(cwd, 'scripts'));
    writeFileSync(
      join(cwd, 'scripts', 'evolve-battery-case.mjs'),
      `import { homedir } from 'node:os';
const reply = JSON.stringify({ home: homedir() });
process.stdout.write(JSON.stringify({ reply, toolCalls: [], approvalsAsked: 0 }) + '\\n');
`,
    );
    const run = batteryRunnerFromEnv(
      { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      { baseUrl: () => 'https://example.invalid/v1', readSecret: async () => 'k' },
    );
    const trace = await run?.({ id: 'h1', prompt: 'hola', machine: {} } as never, cwd);
    const seen = JSON.parse(String(trace?.reply)).home as string;
    expect(seen).not.toBe(REAL);
    expect(seen.startsWith(tmpdir())).toBe(true);
    expect(existsSync(seen)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'el proponedor no ve la carpeta personal real',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'pa-proposer-home-'));
      const bin = join(dir, 'proponer.sh');
      writeFileSync(bin, '#!/bin/sh\nprintf "%s" "$HOME" > "$PA_EVOLVE_DIR/home.txt"\n');
      chmodSync(bin, 0o755);
      const propose = proposerFromEnv({ PATH: process.env.PATH, PA_EVOLVE_PROPOSER: bin });
      await propose?.(dir, 'idea', 1);
      const seen = readFileSync(join(dir, 'home.txt'), 'utf8');
      expect(seen).not.toBe('');
      expect(seen).not.toBe(REAL);
      expect(seen.startsWith(tmpdir())).toBe(true);
      expect(existsSync(seen)).toBe(false);
    },
  );
});
