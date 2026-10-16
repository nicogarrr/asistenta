/** Suite general y fase de recursos separada. No relaja ningún límite del test.
 * npm test -- <args> aplica filtros/opciones solo a la fase general; la fase
 * de recursos corre siempre completa, serial y sin filtros externos.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const RESOURCE_TESTS = ['test/memory-office.test.ts', 'test/factory.test.ts', 'test/diagnose-cli-process.test.ts', 'test/daemon-stop-process.test.ts', 'test/vault-stdin-process.test.ts'];

export function runSuite(args = [], launch = spawnSync) {
  const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
  const general = [vitest, 'run', ...args, ...RESOURCE_TESTS.flatMap((file) => ['--exclude', file])];
  const resources = [vitest, 'run', '--maxWorkers=1', '--fileParallelism=false', ...RESOURCE_TESTS];
  let failed = false;
  // No short-circuit: recursos se ejecuta también si falla o no arranca general.
  for (const [name, command] of [['general', general], ['recursos (serial)', resources]]) {
    console.log(`\nSuite: ${name}`);
    try {
      const result = launch(process.execPath, command, { stdio: 'inherit' });
      if (result.error || result.signal || result.status !== 0) {
        failed = true;
        console.error(`Suite ${name}: fallo (${result.signal ?? result.status ?? 'no arrancó'})`);
      }
    } catch {
      failed = true;
      console.error(`Suite ${name}: no arrancó`);
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = runSuite(process.argv.slice(2));
}
