import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { paths } from './paths.js';
import { terminalQuestion } from './setup-terminal.js';
import { initVault, vaultBackend, vaultGet, vaultSet } from './vault.js';

export interface SetupDeps {
  question(prompt: string, secret?: boolean): Promise<string>;
  write(text: string): void;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  init(): Promise<void>;
  backend(): string;
  prepare(): void;
  config(): { providerPreset?: string; model: string; provider?: string };
  nodeMajor: number;
  built: boolean;
}
const yes = (answer: string) => /^(si|sí)$/i.test(answer.trim());
export async function setupCommand(
  args: string[],
  partial: Partial<SetupDeps> = {},
): Promise<number> {
  if (args.length) {
    (partial.write ?? ((s) => process.stderr.write(s)))(
      'uso: pa setup (terminal local interactiva, sin argumentos secretos)\n',
    );
    return 2;
  }
  const deps: SetupDeps = {
    question: terminalQuestion,
    write: (s) => process.stdout.write(s),
    get: vaultGet,
    set: vaultSet,
    init: initVault,
    backend: vaultBackend,
    prepare() {
      if (existsSync(resolve(paths.state, 'agent.pid')))
        throw new Error(
          'Hay un marcador de daemon existente; revisa status y detén la instancia antes de configurar. Setup no mata ni borra el PID.',
        );
      if (existsSync(paths.state)) {
        const stat = lstatSync(paths.state);
        if (
          stat.isSymbolicLink() ||
          !stat.isDirectory() ||
          (process.platform !== 'win32' &&
            (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
        )
          throw new Error(
            'Revisa el propietario y los permisos privados del directorio de estado; setup no los cambia silenciosamente.',
          );
      } else mkdirSync(paths.state, { recursive: true, mode: 0o700 });
    },
    config: loadConfig,
    nodeMajor: Number(process.versions.node.split('.')[0]),
    built: existsSync(resolve('dist/cli.js')),
    ...partial,
  };
  if (deps.nodeMajor < 24) {
    deps.write('Se requiere Node 24 o posterior; no se ha cambiado nada.\n');
    return 1;
  }
  if (!deps.built) {
    deps.write(
      'Falta dist/cli.js. Ejecuta npm run build desde la raíz del repositorio; setup no instala ni compila por sí solo.\n',
    );
    return 1;
  }
  deps.write(
    'Configuración local en español. No activa autostart ni watchdog, no arranca el daemon y no hace llamadas a Telegram ni al modelo. Cada cambio requiere tu sí. No pegues secretos en un chat.\n',
  );
  if (
    !yes(await deps.question('¿Quieres revisar la configuración local? Escribe sí para continuar'))
  )
    return 0;
  let config: ReturnType<SetupDeps['config']>;
  try {
    config = deps.config();
  } catch {
    deps.write(
      'La configuración actual no es válida; revisa .env sin compartir sus valores. No se ha cambiado nada.\n',
    );
    return 1;
  }
  deps.write(
    'Se conservará la configuración actual del proveedor. Un nombre free no garantiza coste cero ni cuota. Revisa plan, modelo y política de datos antes de usarlo; setup no consume cuota para comprobarlos.\n',
  );
  // Avoid printing model/preset strings: a malformed env may carry private values.

  try {
    deps.prepare();
  } catch {
    deps.write(
      'No se puede preparar el estado: revisa permisos/propietario y cualquier daemon existente con status. No se ha borrado ni matado nada.\n',
    );
    return 1;
  }
  try {
    await deps.get('telegram:botToken');
  } catch {
    deps.write(
      `No se pudo abrir el almacén (${deps.backend() === 'dpapi' ? 'DPAPI ligado a este usuario Windows' : 'portable sin cifrado DPAPI'}). No se muestra el error interno.\n`,
    );
    if (
      !yes(
        await deps.question('¿Inicializar el almacén? No reemplaza un vault existente; escribe sí'),
      )
    )
      return 1;
    try {
      await deps.init();
    } catch {
      deps.write('No se pudo inicializar; no se cambia de backend ni se reemplaza el vault.\n');
      return 1;
    }
  }
  let pending = 0;
  for (const field of [
    {
      key: 'telegram:botToken',
      prompt: 'Token de tu bot creado en BotFather',
      secret: true,
      valid: (v: string) => v.length <= 16384 && /^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(v),
    },
    {
      key: 'telegram:allowedUserIds',
      prompt:
        'Tu ID numérico de usuario Telegram (varios separados por comas, no @nombre ni ID del bot)',
      secret: false,
      valid: (v: string) =>
        v
          .split(',')
          .every((s) => /^[1-9]\d*$/.test(s.trim()) && Number.isSafeInteger(Number(s.trim()))),
    },
    {
      key: 'provider:apiKey',
      prompt: 'Clave del proveedor que ya has configurado, con su plan revisado',
      secret: true,
      valid: (v: string) => v.length > 0 && v.length <= 16384 && !/[\r\n\0]/.test(v),
    },
  ]) {
    if (field.key === 'provider:apiKey' && config.provider === 'opencode-local') {
      deps.write(
        'Proveedor local: setup no pide ni almacena una clave externa; configura y verifica OpenCode por separado.\n',
      );
      continue;
    }
    let current: string | undefined;
    try {
      current = await deps.get(field.key);
    } catch {
      deps.write('No se pudo leer el almacén; no se cambia nada más.\n');
      return 1;
    }
    if (current) {
      deps.write(
        `Se conserva ${field.key}; no se imprime su valor. Para rotarlo usa el comando de vault explícito.\n`,
      );
      continue;
    }
    if (!yes(await deps.question(`Falta ${field.key}. ¿Quieres guardarlo? Escribe sí`))) {
      pending++;
      deps.write(`Pendiente ${field.key}; no se afirma configuración completa.\n`);
      continue;
    }
    if (field.key === 'telegram:botToken')
      deps.write(
        'Abre el perfil verificado de BotFather, usa /newbot y conserva el token en privado. No se consulta ningún bot de terceros.\n',
      );
    const value = await deps.question(field.prompt, field.secret);
    if (!field.valid(value)) {
      deps.write(`Formato no válido para ${field.key}; no se guarda ni se repite el valor.\n`);
      return 1;
    }
    try {
      await deps.set(field.key, value);
    } catch {
      deps.write(
        'No se pudo guardar. Revisa el almacén y sus permisos; no se muestra su error interno.\n',
      );
      return 1;
    }
    deps.write(`Guardado ${field.key}; no se muestra el valor.\n`);
  }
  deps.write(
    'Revisión terminada, no verificación de conexión. No se ha hecho autodetección de ID ni health del modelo, descargado whisper ni registrado autostart. Ejecuta doctor y revisa el diagnóstico; llm-health hace llamadas reales y puede gastar cuota/dinero. Cuando revises esas condiciones, arranca serve y prueba /start desde tu usuario autorizado. Un /start que responde no prueba el modelo.\n',
  );
  return pending ? 1 : 0;
}
