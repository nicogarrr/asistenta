/** Pipeline Biblioteca Secreta sobre el userbot (la cuenta personal de Telegram).
 *
 * Decision de Nico (11-oct-2026): la tool de libros busca primero en las fuentes
 * de dominio publico y, si el libro no esta, lo pide al bot Biblioteca Secreta
 * a traves de su propia cuenta (la Bot API no permite bot-a-bot). Las piezas
 * ya existian sueltas (discover, protocol, userbot); esto las cablea:
 *
 *   busqueda de texto -> lista "Titulo /bCODE" -> /bCODE -> ficha -> boton Epub
 *   -> documento -> bytes que DEBEN oler a EPUB de verdad.
 *
 * Veracidad: nunca se da por descargado lo que no llego. Sin respuesta, sin
 * ficha, sin documento o bytes que no son un EPUB = error honesto, no exito.
 *
 * Anti-flood (es la cuenta personal de Nico, un baneo le duele): todas las
 * interacciones con Telegram pasan por una cola serializada con pausa minima,
 * hay un tope diario persistido en disco (sobrevive a reinicios del servicio)
 * y un FloodWait de Telegram se traduce a "espera N segundos" en vez de
 * reintentar a lo bruto.
 *
 * Credenciales: NUNCA en logs ni en mensajes. configFromEnv ya valida formato;
 * aqui solo se propagan sus errores sin enriquecerlos con valores.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { localDay } from '../datecontext.js';
import { log } from '../log.js';
import { discoverBotHandle, invalidateBotCache } from './discover.js';
import { MAX_BOOK_BYTES } from './net.js';
import { EPUB_BUTTON, parseBookCard, parseSearchResults, sanitizeQuery } from './protocol.js';
import { configFromEnv, createUserbot } from './userbot.js';

/** Lo minimo que el pipeline necesita del cliente de Telegram: los tests
 * inyectan un doble y nunca tocan la red. El TelegramClient real de teleproto
 * cumple esta forma estructuralmente (Message.click, document.size...). */
export interface SecretMessage {
  id: number;
  message?: string;
  document?: { size?: unknown };
  click(opts: { text: string }): Promise<unknown>;
}

export interface SecretTgClient {
  sendMessage(entity: string, opts: { message: string }): Promise<SecretMessage>;
  getMessages(entity: string, opts: { limit: number; minId?: number }): Promise<SecretMessage[]>;
  downloadMedia(message: SecretMessage): Promise<Buffer | string | undefined>;
}

export type SecretStatus = { ok: true } | { ok: false; reason: string };

/** Lo que la tool de libros consume. */
export interface SecretSource {
  status(): Promise<SecretStatus>;
  search(query: string): Promise<Array<{ title: string; code: string }>>;
  download(code: string): Promise<{ title: string; bytes: Buffer }>;
}

export interface SecretDeps {
  /** Fabrica perezosa del cliente ya logueado; por defecto createUserbot con
   * la config del entorno y la sesion persistida por `pa books setup`. */
  getClient?: () => Promise<SecretTgClient>;
  discover?: (opts?: { force?: boolean }) => Promise<string>;
  invalidateDiscovery?: () => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Donde se persiste el contador diario anti-flood. */
  usagePath?: string;
  env?: NodeJS.ProcessEnv;
  sessionPath?: string;
  maxInteractionsPerDay?: number;
  minGapMs?: number;
  replyTimeoutMs?: number;
  pollMs?: number;
}

const MIN_GAP_MS = 1500;
const MAX_INTERACTIONS_PER_DAY = 60;
const REPLY_TIMEOUT_MS = 25_000;
const POLL_MS = 2000;
const CODE_RE = /^b[A-Za-z0-9]{4,5}$/;

/** Un EPUB de verdad: ZIP (cabecera de entrada "PK\\x03\\x04") con las marcas OCF.
 * La spec pide la entrada "mimetype" sin comprimir al principio con
 * application/epub+zip; muchos EPUB reales la guardan comprimida o más tarde, pero
 * todos llevan "META-INF/container.xml", cuyo nombre el ZIP guarda en claro. Misma
 * regla que books/net.ts sniff() (copiada aquí para no crear un ciclo de imports).
 * Un PDF, un HTML renombrado, un DOCX o un ZIP de PDFs no la pasan. */
export function sniffsAsEpub(bytes: Buffer): boolean {
  if (bytes.length < 64) return false;
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04)
    return false;
  if (bytes.subarray(0, 512).includes('application/epub+zip')) return true;
  return bytes.includes('META-INF/container.xml');
}

function floodWaitSeconds(err: unknown): number | undefined {
  const e = err as { seconds?: unknown; errorMessage?: unknown; message?: unknown };
  const seconds = typeof e?.seconds === 'number' ? e.seconds : undefined;
  const text = `${String(e?.errorMessage ?? '')} ${String(e?.message ?? '')}`;
  if (seconds !== undefined && /FLOOD_WAIT/i.test(text)) return seconds;
  const m = text.match(/FLOOD_WAIT_(\d+)/i);
  return m?.[1] ? Number(m[1]) : undefined;
}

interface Usage {
  day: string;
  count: number;
}

export class SecretLibrary implements SecretSource {
  private readonly deps: Required<
    Pick<SecretDeps, 'discover' | 'invalidateDiscovery' | 'sleep' | 'now'>
  > &
    SecretDeps;
  private client: Promise<SecretTgClient> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private lastOpAt = 0;
  private usage: Usage | undefined;

  constructor(deps: SecretDeps = {}) {
    this.deps = {
      discover: discoverBotHandle,
      invalidateDiscovery: invalidateBotCache,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
      ...deps,
    };
  }

  /** Barato y sin red: solo mira si el setup local dejo credenciales y sesion.
   * La tool lo usa para decir "falta X" en vez de explotar a mitad. */
  async status(): Promise<SecretStatus> {
    try {
      configFromEnv(this.deps.env ?? process.env, this.sessionPath());
    } catch {
      return {
        ok: false,
        reason: 'no esta configurada la app de Telegram (falta `pa books setup` en el PC)',
      };
    }
    const path = this.sessionPath();
    const session = existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
    if (!session) {
      return {
        ok: false,
        reason: 'falta el login de Telegram (falta `pa books setup` en el PC)',
      };
    }
    return { ok: true };
  }

  async search(query: string): Promise<Array<{ title: string; code: string }>> {
    const q = sanitizeQuery(query); // lanza si queda vacia
    const client = await this.getClient();
    const handle = await this.discoverHandle();
    const sent = await this.op(() => client.sendMessage(handle, { message: q }));
    const { reply, anyText } = await this.waitReply(client, handle, sent.id, (m) =>
      typeof m.message === 'string' && parseSearchResults(m.message).length > 0 ? m : undefined,
    );
    if (!reply) {
      if (anyText) return []; // el bot respondio: no tiene ese libro
      this.deps.invalidateDiscovery();
      throw new Error('el bot de Biblioteca Secreta no ha respondido a tiempo');
    }
    const hits = parseSearchResults(reply.message ?? '');
    log.info('secret library search', { hits: hits.length });
    return hits;
  }

  async download(code: string): Promise<{ title: string; bytes: Buffer }> {
    if (!CODE_RE.test(code)) throw new Error('codigo de Biblioteca Secreta invalido');
    const client = await this.getClient();
    const handle = await this.discoverHandle();
    const sent = await this.op(() => client.sendMessage(handle, { message: `/${code}` }));
    const { reply: card } = await this.waitReply(client, handle, sent.id, (m) =>
      typeof m.message === 'string' && m.message.trim() ? m : undefined,
    );
    if (!card) {
      this.deps.invalidateDiscovery();
      throw new Error('el bot de Biblioteca Secreta no ha mandado la ficha a tiempo');
    }
    const title = parseBookCard(card.message ?? '')?.title ?? code;
    await this.op(() => card.click({ text: EPUB_BUTTON }));
    const { reply: docMsg } = await this.waitReply(client, handle, sent.id, (m) =>
      m.document ? m : undefined,
    );
    if (!docMsg) {
      throw new Error('el bot no ha mandado el EPUB tras pulsar "Epub"; no se ha descargado nada');
    }
    const declared = Number(String(docMsg.document?.size ?? 0));
    if (Number.isFinite(declared) && declared > MAX_BOOK_BYTES) {
      throw new Error('el EPUB pesa mas del tope (50 MB); no se ha descargado');
    }
    const data = await this.op(() => client.downloadMedia(docMsg));
    if (!Buffer.isBuffer(data)) {
      throw new Error('Telegram no ha devuelto el archivo; no se ha descargado nada');
    }
    if (data.length > MAX_BOOK_BYTES) {
      throw new Error('el EPUB pesa mas del tope (50 MB); no se ha descargado');
    }
    if (!sniffsAsEpub(data)) {
      throw new Error('lo que ha mandado el bot no parece un EPUB de verdad; no lo doy por bueno');
    }
    log.info('secret library download', { bytes: data.length });
    return { title, bytes: data };
  }

  private sessionPath(): string {
    return this.deps.sessionPath ?? 'data/books/userbot.session';
  }

  private async discoverHandle(): Promise<string> {
    return this.deps.discover();
  }

  private getClient(): Promise<SecretTgClient> {
    if (!this.client) {
      const factory =
        this.deps.getClient ??
        (async () =>
          (await createUserbot(
            configFromEnv(this.deps.env ?? process.env, this.sessionPath()),
          )) as unknown as SecretTgClient);
      this.client = factory();
      // Un fallo de conexion no envenena el singleton: el proximo intento reintenta.
      this.client.catch(() => {
        this.client = undefined;
      });
    }
    return this.client;
  }

  /** Cola serializada con pausa minima entre interacciones y tope diario
   * persistido: ni dos peticiones pegadas ni rachas que Telegram castigue. */
  private op<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const gap = (this.deps.minGapMs ?? MIN_GAP_MS) - (this.deps.now() - this.lastOpAt);
      if (gap > 0) await this.deps.sleep(gap);
      this.countInteraction();
      try {
        return await fn();
      } catch (err) {
        const wait = floodWaitSeconds(err);
        if (wait !== undefined) {
          throw new Error(
            `Telegram me esta frenando (anti-flood): hay que esperar ${wait} segundos. Intentalo mas tarde.`,
          );
        }
        throw err;
      } finally {
        this.lastOpAt = this.deps.now();
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private countInteraction(): void {
    const max = this.deps.maxInteractionsPerDay ?? MAX_INTERACTIONS_PER_DAY;
    const day = localDay(this.deps.now());
    if (!this.usage) this.usage = this.loadUsage();
    if (this.usage.day !== day) this.usage = { day, count: 0 };
    if (this.usage.count >= max) {
      throw new Error(
        `tope diario de mensajes al bot alcanzado (${max}, anti-flood). Manana se puede seguir.`,
      );
    }
    this.usage.count += 1;
    this.saveUsage(this.usage);
  }

  private usagePath(): string {
    return this.deps.usagePath ?? join(dirname(this.sessionPath()), 'userbot-usage.json');
  }

  private loadUsage(): Usage {
    try {
      const raw = JSON.parse(readFileSync(this.usagePath(), 'utf8')) as Partial<Usage>;
      if (typeof raw.day === 'string' && typeof raw.count === 'number') {
        return { day: raw.day, count: raw.count };
      }
    } catch {
      // Sin fichero o corrupto: contador nuevo. Nunca bloquea el pipeline.
    }
    return { day: localDay(this.deps.now()), count: 0 };
  }

  private saveUsage(usage: Usage): void {
    try {
      const path = this.usagePath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(usage), { mode: 0o600 });
    } catch (err) {
      log.warn('secret library usage not persisted', { error: String(err) });
    }
  }

  /** Espera una respuesta del bot posterior a nuestro mensaje. `pick` decide
   * que mensaje vale (lista de resultados, ficha, documento). Devuelve ademas
   * si llego CUALQUIER texto: un "no tengo eso" del bot es una respuesta, no
   * un timeout. */
  private async waitReply(
    client: SecretTgClient,
    handle: string,
    afterId: number,
    pick: (m: SecretMessage) => SecretMessage | undefined,
  ): Promise<{ reply: SecretMessage | undefined; anyText: boolean }> {
    const deadline = this.deps.now() + (this.deps.replyTimeoutMs ?? REPLY_TIMEOUT_MS);
    let anyText = false;
    for (;;) {
      const msgs = await client.getMessages(handle, {
        limit: 10,
        minId: afterId,
      });
      const fresh = msgs.filter((m) => m.id > afterId).sort((a, b) => a.id - b.id);
      for (const m of fresh) {
        const picked = pick(m);
        if (picked) return { reply: picked, anyText };
        if (typeof m.message === 'string' && m.message.trim()) anyText = true;
      }
      if (this.deps.now() >= deadline) return { reply: undefined, anyText };
      await this.deps.sleep(this.deps.pollMs ?? POLL_MS);
    }
  }
}
