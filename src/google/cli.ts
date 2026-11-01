/** `pa google conectar | estado | desconectar`: la conexión con tu cuenta de Google. */
import { readFile } from 'node:fs/promises';
import {
  GOOGLE_KEYS,
  GoogleAuth,
  type GoogleDeps,
  parseClientJson,
  startLoopbackFlow,
} from './oauth.js';

export interface GoogleCliDeps extends GoogleDeps {
  print: (line: string) => void;
  readText?: (file: string) => Promise<string>;
}

export const GOOGLE_CLI_HELP =
  'Con Google puedo: «pa google conectar» (la primera vez, con el archivo del cliente: pa google conectar client_secret.json), «pa google estado» y «pa google desconectar». Los pasos están en docs/google.md.';

async function defaultDeps(): Promise<GoogleCliDeps> {
  const { ensureDirs } = await import('../paths.js');
  const { vaultDelete, vaultGet, vaultSet } = await import('../vault.js');
  ensureDirs();
  return {
    vault: { get: vaultGet, set: vaultSet, delete: vaultDelete },
    print: (line) => console.log(line),
  };
}

const what = (scopes: string[]): string[] =>
  [
    scopes.some((s) => s.includes('/auth/calendar')) ? 'Calendar' : '',
    scopes.some((s) => s.includes('/auth/gmail')) ? 'Gmail' : '',
  ].filter(Boolean);

export async function googleCommand(args: string[], given?: GoogleCliDeps): Promise<number> {
  const [sub, file] = args;
  if (sub !== 'conectar' && sub !== 'estado' && sub !== 'desconectar') {
    (given?.print ?? ((l: string) => process.stderr.write(`${l}\n`)))(GOOGLE_CLI_HELP);
    return 2;
  }
  const deps = given ?? (await defaultDeps());
  const auth = new GoogleAuth(deps);
  try {
    if (sub === 'estado') {
      if (!(await auth.connected())) {
        deps.print(
          'Tu cuenta de Google no está conectada. Para conectarla: pa google conectar (pasos en docs/google.md).',
        );
        return 1;
      }
      await auth.accessToken();
      const parts = what(await auth.scopes());
      deps.print(
        parts.length
          ? `Google conectado: leo tu ${parts.join(' y tu ')}.`
          : 'Google está conectado, pero sin permiso para leer tu calendario. Vuelve a hacer «pa google conectar» y acepta el permiso.',
      );
      return 0;
    }
    if (sub === 'desconectar') {
      const was = await auth.disconnect();
      deps.print(
        was
          ? 'Hecho: he retirado el permiso en Google y lo he borrado de la bóveda.'
          : 'Google no estaba conectado.',
      );
      return 0;
    }
    if (file) {
      const { clientId, clientSecret } = parseClientJson(
        await (deps.readText ?? ((f) => readFile(f, 'utf8')))(file),
      );
      await deps.vault.set(GOOGLE_KEYS.clientId, clientId);
      await deps.vault.set(GOOGLE_KEYS.clientSecret, clientSecret);
    }
    const flow = await startLoopbackFlow(deps);
    deps.print('Abre este enlace en el navegador de este mismo PC y acepta el permiso:');
    deps.print(flow.url);
    const { scopes } = await flow.done;
    const parts = what(scopes);
    deps.print(
      parts.length
        ? `Listo: Google conectado. Ya leo tu ${parts.join(' y tu ')} (solo lectura).`
        : 'Google se ha conectado, pero sin el permiso del calendario. Vuelve a probar y marca la casilla del calendario.',
    );
    return 0;
  } catch (err) {
    deps.print(
      err instanceof Error && err.message ? err.message : 'No he podido conectar con Google.',
    );
    return 1;
  }
}
