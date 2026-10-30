import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

/** Solo un directorio nuestro: hijo directo de tmpdir y con nuestro prefijo. */
function removeOwn(dir: string | undefined, prefix: string): void {
  if (!dir) return;
  if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith(prefix)) return;
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * Borra el PA_STATE_DIR y el tmpdir() temporales que vitest.config.ts crea para
 * cada ejecución (este proceso conserva el tmpdir real; los workers ven el suyo).
 */
export default function setup(): () => void {
  return () => {
    removeOwn(process.env.PA_TEST_STATE_DIR, 'pa-test-state-');
    removeOwn(process.env.PA_TEST_TMP_DIR, 'pa-test-tmp-');
  };
}
