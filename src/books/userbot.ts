/** Userbot MTProto (gramjs) para hablar con el bot Biblioteca Secreta.
 *
 * La Bot API no permite bot-a-bot: esto usa la cuenta personal de Nico.
 * Credenciales: NUNCA en codigo, logs ni chat. Se leen de variables de
 * entorno (BOOKS_TG_API_ID / BOOKS_TG_API_HASH) que la pagina de setup de
 * asistenta escribe en el .env local (0600) desde el vault de Nico.
 * La sesion StringSession se persiste en disco con permisos 0600.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Api, TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';

export interface UserbotConfig {
  apiId: number;
  apiHash: string;
  sessionPath: string; // fichero StringSession, se crea con 0600
}

export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  sessionPath = 'data/books/userbot.session',
): UserbotConfig {
  const apiId = Number(env.BOOKS_TG_API_ID);
  const apiHash = env.BOOKS_TG_API_HASH ?? '';
  if (!Number.isInteger(apiId) || apiId <= 0) {
    throw new Error('BOOKS_TG_API_ID no configurado (pagina de setup pendiente)');
  }
  if (!apiHash.trim()) {
    throw new Error('BOOKS_TG_API_HASH no configurado (pagina de setup pendiente)');
  }
  return { apiId, apiHash, sessionPath };
}

function loadSession(path: string): StringSession {
  if (existsSync(path)) return new StringSession(readFileSync(path, 'utf8').trim());
  return new StringSession('');
}

function saveSession(path: string, session: StringSession): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, session.save(), { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Cliente conectado; el caller decide si hace login o usa sesion guardada. */
export async function createUserbot(config: UserbotConfig): Promise<TelegramClient> {
  const session = loadSession(config.sessionPath);
  const client = new TelegramClient(session, config.apiId, config.apiHash, {
    connectionRetries: 3,
  });
  await client.connect();
  return client;
}

/** Persiste la sesion tras un login correcto. */
export function persistSession(config: UserbotConfig, client: TelegramClient): void {
  saveSession(config.sessionPath, client.session as StringSession);
}

/** Estado del login: lo justo para reanudar entre request y complete. */
export interface PendingLogin {
  phoneNumber: string;
  phoneCodeHash: string;
}

export async function requestLoginCode(
  config: UserbotConfig,
  phoneNumber: string,
): Promise<PendingLogin> {
  const client = await createUserbot(config);
  try {
    const result = await client.invoke(
      new Api.auth.SendCode({
        phoneNumber,
        apiId: config.apiId,
        apiHash: config.apiHash,
        settings: new Api.CodeSettings({}),
      }),
    );
    if (!(result instanceof Api.auth.SentCode)) {
      throw new Error('Telegram no devolvio un envio de codigo');
    }
    return { phoneNumber, phoneCodeHash: result.phoneCodeHash };
  } finally {
    await client.disconnect();
  }
}

export async function completeLogin(
  config: UserbotConfig,
  pending: PendingLogin,
  code: string,
  password?: string,
): Promise<void> {
  const client = await createUserbot(config);
  try {
    await client.invoke(
      new Api.auth.SignIn({
        phoneNumber: pending.phoneNumber,
        phoneCodeHash: pending.phoneCodeHash,
        phoneCode: code,
      }),
    );
  } catch (err) {
    // 2FA: Telegram pide la contraseña de verificacion en dos pasos.
    if (err instanceof Error && err.message.includes('SESSION_PASSWORD_NEEDED')) {
      if (!password) throw new Error('2FA requerido: falta la contraseña (vault)');
      const { computeCheck } = await import('teleproto/Password.js');
      const pwd = await client.invoke(new Api.account.GetPassword());
      await client.invoke(
        new Api.auth.CheckPassword({ password: await computeCheck(pwd, password) }),
      );
    } else {
      throw err;
    }
  }
  persistSession(config, client);
  await client.disconnect();
}
