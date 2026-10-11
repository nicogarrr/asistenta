/** Userbot MTProto (teleproto) para hablar con el bot Biblioteca Secreta.
 *
 * La Bot API no permite bot-a-bot: esto usa la cuenta personal de Nico (la
 * corona: va con token de setup, validacion estricta y loopback).
 * Credenciales: NUNCA en codigo, logs ni chat. Variables de entorno
 * (BOOKS_TG_API_ID / BOOKS_TG_API_HASH) escritas por la pagina de setup
 * local. Sesion StringSession persistida en disco con 0600.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Api, TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';

export interface UserbotConfig {
  apiId: number;
  apiHash: string;
  sessionPath: string;
}

export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  sessionPath = 'data/books/userbot.session',
): UserbotConfig {
  const apiIdRaw = env.BOOKS_TG_API_ID ?? '';
  const apiHash = env.BOOKS_TG_API_HASH ?? '';
  if (!/^\d{1,12}$/.test(apiIdRaw)) {
    throw new Error('BOOKS_TG_API_ID no configurado o con formato invalido');
  }
  if (!/^[a-f0-9]{32}$/i.test(apiHash)) {
    throw new Error('BOOKS_TG_API_HASH no configurado o con formato invalido');
  }
  return { apiId: Number(apiIdRaw), apiHash, sessionPath };
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

const PENDING_TTL_MS = 10 * 60 * 1000;

/** Flujo de login en 2 pasos sobre UNA MISMA conexion: el phoneCodeHash de
 * Telegram va ligado a la auth key de la conexion que lo pidio; cambiar de
 * cliente entre request y complete rompe el login. */
export class LoginFlow {
  private client: TelegramClient | undefined;
  private pending: { phoneNumber: string; phoneCodeHash: string; at: number } | undefined;

  private readonly config: UserbotConfig;

  constructor(config: UserbotConfig) {
    this.config = config;
  }

  private async ensureClient(): Promise<TelegramClient> {
    if (!this.client) {
      this.client = new TelegramClient(
        loadSession(this.config.sessionPath),
        this.config.apiId,
        this.config.apiHash,
        { connectionRetries: 3 },
      );
      await this.client.connect();
    }
    return this.client;
  }

  async requestCode(phoneNumber: string): Promise<void> {
    try {
      const client = await this.ensureClient();
      const result = await client.invoke(
        new Api.auth.SendCode({
          phoneNumber,
          apiId: this.config.apiId,
          apiHash: this.config.apiHash,
          settings: new Api.CodeSettings({}),
        }),
      );
      if (!(result instanceof Api.auth.SentCode)) {
        throw new Error('Telegram no devolvio un envio de codigo');
      }
      this.pending = { phoneNumber, phoneCodeHash: result.phoneCodeHash, at: Date.now() };
    } catch (err) {
      // Un requestCode fallido no deja la conexion abierta.
      await this.dispose();
      throw err;
    }
  }

  async complete(code: string, password?: string): Promise<void> {
    const pending = this.pending;
    if (!pending || Date.now() - pending.at > PENDING_TTL_MS) {
      // El TTL vencido tambien cierra la conexion que pudo quedar abierta.
      await this.dispose();
      throw new Error('El login caduco: pide un codigo nuevo');
    }
    // Exito o fallo (codigo erroneo, 2FA pendiente, saveSession roto): la
    // conexion se cierra siempre. Reintentar = pedir un codigo nuevo.
    try {
      const client = await this.ensureClient();
      try {
        await client.invoke(
          new Api.auth.SignIn({
            phoneNumber: pending.phoneNumber,
            phoneCodeHash: pending.phoneCodeHash,
            phoneCode: code,
          }),
        );
      } catch (err) {
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
      saveSession(this.config.sessionPath, client.session as StringSession);
    } finally {
      await this.dispose();
    }
  }

  async dispose(): Promise<void> {
    this.pending = undefined;
    if (this.client) {
      await this.client.disconnect();
      this.client = undefined;
    }
  }
}

/** Cliente ya logueado (sesion persistida) para el pipeline de libros. */
export async function createUserbot(config: UserbotConfig): Promise<TelegramClient> {
  const client = new TelegramClient(loadSession(config.sessionPath), config.apiId, config.apiHash, {
    connectionRetries: 3,
  });
  await client.connect();
  if (!(await client.checkAuthorization())) {
    await client.disconnect();
    throw new Error('Sin sesion valida: haz el login desde la pagina de setup');
  }
  return client;
}
