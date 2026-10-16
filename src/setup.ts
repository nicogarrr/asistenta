import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { paths } from './paths.js';
import { desktopEnabled } from './platform.js';
import {
  acquireSetupOwnership,
  inspectSetupOwnership,
  type SetupOwnership,
} from './setup-ownership.js';
import { terminalQuestion } from './setup-terminal.js';
import { configurePortableVault, type VaultFieldSource } from './vault.js';

export interface SetupDeps {
  question(prompt: string, secret?: boolean): Promise<string>;
  write(text: string): void;
  inspect(): void;
  acquire(): SetupOwnership;
  configure(
    keys: readonly string[],
    review: (fields: readonly VaultFieldSource[]) => Promise<Record<string, string> | undefined>,
  ): Promise<boolean>;
  config(): { provider?: string };
  prerequisites(): boolean;
  platform: NodeJS.Platform;
  desktop: boolean;
  interactive: boolean;
  nodeMajor: number;
  built: boolean;
}
const yes = (s: string) => /^(si|sí)$/i.test(s.trim());
export async function setupCommand(
  args: string[],
  partial: Partial<SetupDeps> = {},
): Promise<number> {
  const write = partial.write ?? ((s) => process.stdout.write(s));
  if (args.length) {
    write('uso: pa setup (terminal local, sin argumentos secretos)\n');
    return 2;
  }
  const deps: SetupDeps = {
    question: terminalQuestion,
    write,
    inspect: () => inspectSetupOwnership(paths.state),
    acquire: () => acquireSetupOwnership(paths.state),
    configure: configurePortableVault,
    config: loadConfig,
    prerequisites: () =>
      spawnSync('flock', ['--version'], { stdio: 'ignore', timeout: 3000 }).status === 0,
    platform: process.platform,
    desktop: desktopEnabled(),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    nodeMajor: Number(process.versions.node.split('.')[0]),
    built: existsSync(resolve('dist/cli.js')),
    ...partial,
  };
  // Windows guide-only, before TTY, paths, vault, ACL or prompts.
  if (deps.platform !== 'linux') {
    write(
      'Guía solamente en esta plataforma. El wizard con cambios requiere Linux/servidor; Windows aún necesita mutex/DACL y prueba TTY nativa. Consulta README. No se ha creado estado ni abierto el almacén.\n',
    );
    return 2;
  }
  if (deps.desktop) {
    write('El wizard Linux requiere modo servidor (PA_DESKTOP=off); no se ha cambiado nada.\n');
    return 1;
  }
  if (deps.nodeMajor < 24 || !deps.built || !deps.prerequisites()) {
    write(
      'Se requieren Node24, dist/cli.js compilado y flock disponible; no se ha cambiado nada.\n',
    );
    return 1;
  }
  if (!deps.interactive) {
    write(
      'pa setup requiere una terminal local interactiva; no pegues secretos en chats ni argumentos.\n',
    );
    return 1;
  }
  try {
    deps.inspect();
  } catch {
    write(
      'Estado previo/legacy ambiguo o permisos no seguros. No se sondea ni borra nada; revisa el estado antes de configurar.\n',
    );
    return 1;
  }
  let provider: string | undefined;
  try {
    provider = deps.config().provider;
  } catch {
    write('Configuración no válida; revisa .env sin compartir valores. No se ha cambiado nada.\n');
    return 1;
  }
  write(
    'Configuración local parcial. Sin red, llamadas al modelo, autostart, descargas ni comprobación del token. No se cambia proveedor ni backend. Se conservarán campos existentes salvo reemplazo explícito; cambios solo tras confirmación final. No pegues secretos en un chat.\n',
  );
  try {
    if (!yes(await deps.question('¿Continuar? Escribe sí'))) return 0;
  } catch {
    write('Configuración cancelada; no se ha cambiado nada.\n');
    return 1;
  }
  let owner: SetupOwnership;
  try {
    owner = deps.acquire();
  } catch {
    write('No se pudo adquirir propiedad exclusiva. No se cambia el almacén.\n');
    return 1;
  }
  let pending = 0;
  let cancelled = false;
  try {
    const saved = await deps.configure(
      [
        'telegram:botToken',
        'telegram:allowedUserIds',
        ...(provider === 'opencode-local' ? [] : ['provider:apiKey']),
      ],
      async (fields) => {
        const proposed: Record<string, string> = {};
        for (const field of fields) {
          owner.assert();
          if (field.source === 'environment') {
            write(
              `${field.key}: configurado desde entorno; no se copia a archivo ni se ofrece cambiarlo.\n`,
            );
            continue;
          }
          write(
            `${field.key}: ${field.source === 'file' ? 'configurado desde archivo' : 'pendiente'}.\n`,
          );
          const choice = await deps.question(
            field.source === 'file'
              ? `¿Reemplazar ${field.key}? Escribe reemplazar o Enter para conservar`
              : `¿Preparar ${field.key}? Escribe sí o Enter para omitir`,
          );
          if (
            field.source === 'file' ? choice.trim().toLowerCase() !== 'reemplazar' : !yes(choice)
          ) {
            if (field.source === 'missing') pending++;
            continue;
          }
          if (field.key === 'telegram:botToken')
            write(
              'Crea el bot en el perfil verificado de BotFather con /newbot. El formato no prueba que el token sea válido; no se consulta ningún bot de terceros.\n',
            );
          if (field.key === 'provider:apiKey')
            write(
              'Clave del proveedor que ya has configurado: revisa su plan y política de datos antes de usarla. Un nombre free no garantiza coste cero.\n',
            );
          const value = await deps.question(
            field.key === 'telegram:allowedUserIds'
              ? 'Tu ID numérico de usuario Telegram (no @nombre ni ID del bot; varios separados por comas)'
              : field.key,
            field.key !== 'telegram:allowedUserIds',
          );
          if (value === '') {
            if (field.source === 'missing') pending++;
            continue;
          }
          const valid =
            field.key === 'telegram:allowedUserIds'
              ? value
                  .split(',')
                  .every(
                    (s) => /^[1-9]\d*$/.test(s.trim()) && Number.isSafeInteger(Number(s.trim())),
                  )
              : field.key === 'telegram:botToken'
                ? /^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(value)
                : !/[\r\n\0]/.test(value);
          if (!valid || value.length > 16384)
            throw new Error('Formato de campo no válido; no se guarda ningún cambio.');
          proposed[field.key] = value;
        }
        owner.assert();
        const keys = Object.keys(proposed);
        if (!keys.length) return undefined;
        write(
          `Cambios propuestos solo en: ${keys.join(', ')}. No se muestran valores ni longitudes.\n`,
        );
        if (
          !yes(
            await deps.question(
              '¿Guardar juntos estos cambios? Escribe sí; cualquier otra respuesta cancela todos',
            ),
          )
        ) {
          cancelled = true;
          return undefined;
        }
        owner.assert();
        return proposed;
      },
    );
    write(
      cancelled
        ? 'Cancelado: ningún secreto/configuración cambiado.\n'
        : saved
          ? 'Configuración guardada en un único commit local. No se ha probado que Telegram/modelo funcione ni que sea gratis.\n'
          : 'Sin cambios guardados.\n',
    );
    write(
      'Pendientes fuera de este wizard: autodetección ID, health real, descargas y autostart. Revisa doctor/README antes de arrancar serve y probar /start. Un /start que responde no prueba el modelo. Lock/directorios de coordinación privados pueden quedar, sin READY ni prueba de cierre publicados por setup.\n',
    );
    return pending ? 1 : 0;
  } catch {
    write(
      'Configuración cancelada o no verificable; no se confirmó ningún commit. No se muestra el error interno ni valores. Revisa el almacén antes de reintentar.\n',
    );
    return 1;
  } finally {
    owner.release();
  }
}
