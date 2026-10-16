import { homedir } from 'node:os';
import { resolve, join } from 'node:path';

// Same parser/precedence as the CLI. Emit only the resolved path, never secrets.
try {
  process.loadEnvFile();
} catch (error) {
  if (error.code !== 'ENOENT') {
    process.stderr.write('No se pudo leer el .env del repositorio.\n');
    process.exit(2);
  }
}
console.log(resolve(process.env.PA_STATE_DIR || join(homedir(), '.local', 'share', 'personal-agent')));
