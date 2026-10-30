import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

/** Borra el PA_STATE_DIR temporal que vitest.config.ts crea para cada ejecución. */
export default function setup(): () => void {
  return () => {
    const dir = process.env.PA_TEST_STATE_DIR;
    if (!dir) return;
    // Solo un directorio nuestro: hijo directo de tmpdir y con nuestro prefijo.
    if (
      dirname(resolve(dir)) !== resolve(tmpdir()) ||
      !basename(dir).startsWith('pa-test-state-')
    ) {
      return;
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  };
}
