import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * MUST be the first import of factory.test.ts. `paths.ts` snapshots
 * PA_STATE_DIR at module evaluation, and any static import that transitively
 * loads it (permissions.ts -> log.ts -> paths.ts) would freeze the REAL
 * daemon state dir before the test body assigns its own. Importing this
 * module first fixes the order. A fresh mkdtemp per run also makes the suite
 * idempotent: consecutive runs no longer inherit tools from the previous one.
 */
export const FACTORY_TEST_STATE_DIR = mkdtempSync(join(tmpdir(), 'pa-factory-'));
process.env.PA_STATE_DIR = FACTORY_TEST_STATE_DIR;
