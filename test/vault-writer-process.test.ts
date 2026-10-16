import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { it as baseIt, expect } from 'vitest';

const it = process.platform === 'linux' ? baseIt : baseIt.skip;
function child(code: string, env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, ['--input-type=module', '-e', code], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function done(p: ChildProcess): Promise<void> {
  return new Promise((yes, no) => {
    let error = '';
    p.stderr?.on('data', (c) => {
      error += c;
    });
    p.once('error', no);
    p.once('exit', (code) =>
      code === 0 ? yes() : no(new Error(`synthetic writer exited ${code}: ${error}`)),
    );
  });
}
it('all init/set/setMany/rm writers in distinct processes share one effective external secrets-file lock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-vault-concurrent-'));
  const file = join(dir, 'shared.json');
  const vault = pathToFileURL(resolve('dist/vault.js')).href;
  try {
    const processes = Array.from({ length: 12 }, (_, i) => {
      const state = join(dir, `state-${i}`);
      mkdirSync(state, { mode: 0o700 });
      const env = {
        ...process.env,
        PA_VAULT_BACKEND: 'portable',
        PA_STATE_DIR: state,
        PA_SECRETS_FILE: file,
      };
      return child(
        `import {initVault,vaultSet,vaultSetMany,vaultDelete} from ${JSON.stringify(vault)};await initVault();await vaultSet('single-${i}','synthetic');await vaultSetMany({'batch-${i}':'synthetic','delete-${i}':'synthetic'});await vaultDelete('delete-${i}');`,
        env,
      );
    });
    await Promise.all(processes.map(done));
    const actual = JSON.parse(readFileSync(file, 'utf8'));
    expect(Object.keys(actual).sort()).toEqual(
      Array.from({ length: 12 }, (_, i) => [`single-${i}`, `batch-${i}`])
        .flat()
        .sort(),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);
it('releases the kernel lock when our holder fixture crashes, without deleting lock files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-vault-crash-'));
  const file = join(dir, 'shared.json');
  const module = pathToFileURL(resolve('dist/vault-file-lock.js')).href;
  const env = {
    ...process.env,
    PA_VAULT_BACKEND: 'portable',
    PA_STATE_DIR: dir,
    PA_SECRETS_FILE: file,
  };
  const holder = child(
    `import {withPortableVaultLock} from ${JSON.stringify(module)};await withPortableVaultLock(${JSON.stringify(file)},async()=>{console.log('held');setInterval(()=>{},1000);await new Promise(()=>{});});`,
    env,
  );
  try {
    await new Promise<void>((yes, no) => {
      const t = setTimeout(() => no(new Error('holder not ready')), 5000);
      holder.stdout?.once('data', () => {
        clearTimeout(t);
        yes();
      });
      holder.once('exit', () => {
        clearTimeout(t);
        no(new Error('holder exited'));
      });
    });
    const writer = child(
      `import {withPortableVaultLock} from ${JSON.stringify(module)};await withPortableVaultLock(${JSON.stringify(file)},async()=>{});`,
      env,
    );
    const result = done(writer);
    await new Promise((r) => setTimeout(r, 100));
    expect(writer.exitCode).toBe(null);
    holder.kill('SIGKILL');
    await new Promise((r) => holder.once('exit', r));
    await result;
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
