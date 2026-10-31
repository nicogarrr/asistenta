import { execFile } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { uniqueTmpPath } from './fs-tmp.js';
import { paths } from './paths.js';
import { withPortableVaultLock } from './vault-file-lock.js';

const execFileAsync = promisify(execFile);

/**
 * Secret store: AES-256-GCM over a random 32-byte DEK, and the DEK itself is
 * wrapped with Windows DPAPI (CryptProtectData).
 *
 * Why DPAPI and not a passphrase: the agent runs unattended at 3am, so nobody is
 * there to type a master password. DPAPI scopes the DEK to this Windows user
 * account on this machine, which is exactly the threat model for "a daemon that
 * controls my PC". The trade-off is stated plainly: copy `agent.db` and
 * `vault.enc` to another machine and the secrets will not follow. That is a
 * feature for a personal agent.
 *
 * There is no recovery path by design. If the DPAPI blob is gone, rotate the
 * secrets; do not build a backdoor.
 */
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

interface VaultFile {
  version: 1;
  /** base64 wrapped DEK, DPAPI CurrentUser scope. */
  wrappedDek: string;
  /** base64 AES-GCM ciphertext of the JSON secret map. */
  ciphertext: string;
}

const cache = new Map<string, string>();

/**
 * Backends. Windows keeps DPAPI (default there). Anywhere else, or when
 * PA_VAULT_BACKEND=portable, secrets come from environment variables
 * (PA_SECRET_<KEY>, key upper-cased with every non-alphanumeric run turned into
 * "_": telegram:botToken -> PA_SECRET_TELEGRAM_BOTTOKEN) and, optionally, from a
 * JSON file at PA_SECRETS_FILE or <state>/secrets.json. The file must not be
 * readable by group/other (chmod 600): a loose file is refused rather than used.
 * Environment values win over the file. DPAPI cannot exist off Windows, and the
 * portable backend trades its machine binding for filesystem permissions.
 */
export type VaultBackend = 'dpapi' | 'portable';

export function vaultBackend(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): VaultBackend {
  const forced = env.PA_VAULT_BACKEND?.trim().toLowerCase();
  if (forced === 'dpapi' || forced === 'portable') return forced;
  return platform === 'win32' ? 'dpapi' : 'portable';
}

export function envSecretName(key: string): string {
  return `PA_SECRET_${key.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

export function portableSecretsFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.PA_SECRETS_FILE?.trim() || join(dirname(paths.vault), 'secrets.json');
}

function readPortableFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  if (process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0) {
    throw new Error(`${file} es legible por otros usuarios; ejecuta: chmod 600 ${file}`);
  }
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} debe ser un objeto JSON {"clave": "valor"}`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
  return out;
}

export function loadPortableMap(
  env: NodeJS.ProcessEnv = process.env,
  file: string = portableSecretsFile(env),
): Record<string, string> {
  const map = readPortableFile(file);
  // Env wins: map each known key (file keys plus the keys the app asks for) to its variable.
  const known = new Set([...Object.keys(map), ...PORTABLE_KEYS]);
  for (const key of known) {
    const v = env[envSecretName(key)];
    if (v !== undefined && v !== '') map[key] = v;
  }
  return map;
}

/** Keys the app reads, so env-only setups need no file. */
const PORTABLE_KEYS = [
  'provider:apiKey',
  'telegram:botToken',
  'telegram:allowedUserIds',
  'calendar:icsUrl',
  'agent:fullControl',
  'agent:voice',
  'agent:wake',
  'agent:wakeWord',
];

function writePortableFile(file: string, map: Record<string, string>): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(map, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw error;
  }
}

/**
 * DPAPI via PowerShell. .NET's ProtectedData is the only dependency-free path to
 * user-scoped key protection from Node without a native addon, and it is what
 * protects the credential stores of every Windows-native app.
 */
async function dpapi(data: Buffer, protect: boolean): Promise<Buffer> {
  const mode = protect ? 'Protect' : 'Unprotect';
  // Base64 in, base64 out: keeps binary safe across the process boundary.
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$b = [Convert]::FromBase64String('${data.toString('base64')}')
$out = [System.Security.Cryptography.ProtectedData]::${mode}($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($out)
`;
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      // A hung powershell (profile, locked DPAPI, GPO) must fail fast instead of
      // hanging vault reads, daemon boot, and agent creation with no log at all.
      timeout: 15_000,
    },
  );
  return Buffer.from(stdout.trim(), 'base64');
}

/**
 * Atomic vault write: tmp file + rename, so a crash mid-write leaves the previous
 * vault intact instead of a truncated file. (Also note: `mode: 0o600` is honored
 * on POSIX only; on Windows the file inherits the user ACL, which for a file under
 * the user's own profile is equivalent in practice.)
 */
function writeVaultFile(payload: VaultFile): void {
  mkdirSync(dirname(paths.vault), { recursive: true });
  const tmp = uniqueTmpPath(paths.vault);
  writeFileSync(tmp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, paths.vault);
}

export function vaultExists(): boolean {
  if (vaultBackend() === 'portable') return true;
  return existsSync(paths.vault);
}

/** Create the vault with an empty secret map. Idempotent: refuses to clobber. */
async function initVaultUnlocked(): Promise<void> {
  if (vaultBackend() === 'portable') {
    const file = portableSecretsFile();
    if (!existsSync(file)) writePortableFile(file, {});
    return;
  }
  if (vaultExists()) throw new Error(`vault already exists at ${paths.vault}`);
  const dek = randomBytes(32);
  const wrapped = await dpapi(dek, true);
  const payload: VaultFile = {
    version: 1,
    wrappedDek: wrapped.toString('base64'),
    ciphertext: encrypt(JSON.stringify({}), dek),
  };
  writeVaultFile(payload);
}

function encrypt(plaintext: string, dek: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, dek, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  // iv || tag || ciphertext: GCM is unauthenticated without an explicit tag field.
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

function decrypt(encoded: string, dek: Buffer): string {
  const raw = Buffer.from(encoded, 'base64');
  if (raw.length <= IV_BYTES + TAG_BYTES) throw new Error('vault payload is truncated');
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGO, dek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

async function loadMap(): Promise<Record<string, string>> {
  if (vaultBackend() === 'portable') {
    const map = loadPortableMap();
    for (const [k, v] of Object.entries(map)) cache.set(k, v);
    return map;
  }
  if (!existsSync(paths.vault))
    throw new Error(
      `No hay caja fuerte de claves en ${paths.vault}. Haz doble clic en instalar.bat (o usa pa vault init).`,
    );
  const file = JSON.parse(readFileSync(paths.vault, 'utf8')) as VaultFile;
  if (file.version !== 1) throw new Error(`unsupported vault version ${file.version}`);
  const dek = await dpapi(Buffer.from(file.wrappedDek, 'base64'), false);
  const map = JSON.parse(decrypt(file.ciphertext, dek)) as Record<string, string>;
  for (const [k, v] of Object.entries(map)) cache.set(k, v);
  return map;
}

/**
 * Persist the secret map. `deletions` names keys that must NOT survive the
 * write: the portable backend merges over the on-disk file (so env-managed
 * keys keep their file copy), and without an explicit deletion set a removed
 * key would silently resurrect from that file on the next read.
 */
async function saveMap(
  map: Record<string, string>,
  deletions?: ReadonlySet<string>,
): Promise<void> {
  if (vaultBackend() === 'portable') {
    // Only the file is writable; values that come from the environment stay there.
    const fileMap = readPortableFile(portableSecretsFile());
    for (const key of Object.keys(map)) {
      if (process.env[envSecretName(key)]) delete map[key];
    }
    const merged = { ...fileMap, ...map };
    if (deletions) {
      for (const key of deletions) delete merged[key];
    }
    writePortableFile(portableSecretsFile(), merged);
    return;
  }
  const dek = randomBytes(32);
  const wrapped = await dpapi(dek, true);
  // A fresh DEK per write keeps it forward-secure: overwriting a secret does not
  // leave the old one recoverable from the wrapped blob.
  const payload: VaultFile = {
    version: 1,
    wrappedDek: wrapped.toString('base64'),
    ciphertext: encrypt(JSON.stringify(map), dek),
  };
  writeVaultFile(payload);
}

export async function unlock(): Promise<void> {
  await loadMap();
}

// Cola de escritura por proceso: loadMap + mutacion + saveMap es UNA
// operacion. Sin ella, dos escrituras concurrentes del mismo proceso cargan
// el mismo mapa viejo y la segunda pierde las claves de la primera (con el
// backend DPAPI, async, basta un await en medio).
let writeChain: Promise<void> = Promise.resolve();

export async function initVault(): Promise<void> {
  return runWriteExclusive(initVaultUnlocked);
}

function runWriteExclusive<T>(op: () => Promise<T>): Promise<T> {
  const run = writeChain.then(() =>
    vaultBackend() === 'portable' ? withPortableVaultLock(portableSecretsFile(), op) : op(),
  );
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** True when an environment variable overrides this key (env wins). */
function hasEnvOverride(key: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[envSecretName(key)];
  return v !== undefined && v !== '';
}

/**
 * Cache must mirror what survives a restart. When an env override owns the
 * key, saveMap never writes it to the file, so the written value must NOT
 * stay in cache either: drop it and let the next read re-resolve the env.
 */
function syncCacheAfterWrite(key: string, value: string): void {
  if (hasEnvOverride(key)) {
    cache.delete(key);
  } else {
    cache.set(key, value);
  }
}

export async function vaultSet(key: string, value: string): Promise<void> {
  return runWriteExclusive(async () => {
    const map = await loadMap();
    map[key] = value;
    await saveMap(map);
    // Cache SOLO tras escritura durable: si saveMap falla, vaultGet no debe
    // devolver un valor que nunca llego al disco.
    syncCacheAfterWrite(key, value);
  });
}

/**
 * Set several keys in ONE load+save: the batch either lands together or not
 * at all (single file write). Use it for values that are only meaningful as a
 * group (e.g. mail:address + mail:password), so a failure mid-write never
 * leaves half a pair confirmed. Serialized against writes in this process. Linux portable writers also
 * hold an OS file lock keyed by the effective secrets file, including init/set/rm.
 * Other platforms retain their existing behavior; no Windows mutex is claimed.
 */
export async function vaultSetMany(entries: Record<string, string>): Promise<void> {
  return runWriteExclusive(async () => {
    const map = await loadMap();
    for (const [key, value] of Object.entries(entries)) {
      map[key] = value;
    }
    await saveMap(map);
    // Cache SOLO tras escritura durable (misma regla que vaultSet).
    for (const [key, value] of Object.entries(entries)) {
      syncCacheAfterWrite(key, value);
    }
  });
}

export async function vaultGet(key: string): Promise<string | undefined> {
  // Env gana SIEMPRE y para CUALQUIER clave: se resuelve directamente antes
  // de cache/fichero, sin lista fija de claves. Asi una variable creada (o
  // cambiada) despues de cachear sigue ganando, y las claves env-only son
  // legibles aunque nunca hayan tocado el fichero.
  const env = process.env[envSecretName(key)];
  if (env !== undefined && env !== '') return env;
  if (cache.has(key)) return cache.get(key);
  const map = await loadMap();
  return map[key];
}

/**
 * Delete one key. NOTE: deleting does NOT revoke a secret that lives in the
 * environment (PA_SECRET_<KEY> always wins over cache and file); to retire
 * such a secret the variable itself must be removed.
 */
export async function vaultDelete(key: string): Promise<boolean> {
  return runWriteExclusive(async () => {
    const map = await loadMap();
    if (!(key in map)) return false;
    delete map[key];
    // Explicit deletion set: without it the portable merge would resurrect
    // the key from the on-disk file (saveMap merges over fileMap).
    await saveMap(map, new Set([key]));
    cache.delete(key);
    return true;
  });
}

/** Keys only, never values, so listing cannot leak a secret into a transcript. */
export async function vaultList(): Promise<string[]> {
  return Object.keys(await loadMap()).sort();
}

/**
 * EVERY value the vault interface would return right now, as ONE snapshot:
 * the decrypted map (file/DPAPI) plus every PA_SECRET_* environment variable,
 * because vaultGet resolves env for ANY key - an env-only secret is invisible
 * to vaultList but readable by vaultGet, so a check that wants "no current
 * vault value" must see them all. For internal guards only: values in, values
 * compared, nothing logged, returned to a tool result, or sent to a model.
 * Two reads a millisecond apart can legitimately differ (rotation); callers
 * get one consistent snapshot per operation and say so.
 */
export async function vaultSnapshotValues(): Promise<string[]> {
  const values = new Set<string>();
  for (const v of Object.values(await loadMap())) {
    if (v.length > 0) values.add(v);
  }
  for (const [name, v] of Object.entries(process.env)) {
    if (name.startsWith('PA_SECRET_') && v !== undefined && v !== '') values.add(v);
  }
  return [...values];
}

export function clearVaultCache(): void {
  cache.clear();
}

export interface VaultFieldSource {
  key: string;
  source: 'environment' | 'file' | 'missing';
}
function portableVersion(file: string): string {
  let fd: number | undefined;
  try {
    const stat = lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    )
      throw new Error('Almacén ambiguo.');
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const actual = fstatSync(fd);
    if (actual.ino !== stat.ino || actual.dev !== stat.dev) throw new Error('Almacén modificado.');
    const bytes = readFileSync(fd);
    try {
      return createHash('sha256')
        .update(bytes)
        .update(JSON.stringify([stat.dev, stat.ino, stat.mode, stat.mtimeMs, stat.ctimeMs]))
        .digest('hex');
    } finally {
      bytes.fill(0);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw new Error('No se puede verificar el almacén actual.');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function environmentVersion(): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        Object.entries(process.env)
          .filter(
            ([key]) =>
              key.startsWith('PA_SECRET_') ||
              key === 'PA_SECRETS_FILE' ||
              key === 'PA_VAULT_BACKEND',
          )
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
    .digest('hex');
}
/** Internal wizard API: daemon ownership must already be held. Never expose values to prompts. */
export async function configurePortableVault(
  keys: readonly string[],
  review: (fields: readonly VaultFieldSource[]) => Promise<Record<string, string> | undefined>,
): Promise<boolean> {
  if (process.platform !== 'linux' || vaultBackend() !== 'portable')
    throw new Error(
      'Configuración con cambios solo disponible para portable en Linux; Windows es solo guía.',
    );
  if (!keys.length || keys.some((key) => !/^[a-zA-Z][a-zA-Z0-9:_.-]{0,127}$/.test(key)))
    throw new Error('Campos de configuración inválidos.');
  return runWriteExclusive(async () => {
    const file = portableSecretsFile();
    const version = portableVersion(file);
    const envVersion = environmentVersion();
    let original: Record<string, string>;
    try {
      original = readPortableFile(file);
    } catch {
      throw new Error(
        'No se pudo abrir el almacén; no se inicializa ni reemplaza automáticamente.',
      );
    }
    const fields = keys.map(
      (key) =>
        ({
          key,
          source: hasEnvOverride(key) ? 'environment' : original[key] ? 'file' : 'missing',
        }) as VaultFieldSource,
    );
    const changes = await review(fields);
    if (changes === undefined) return false;
    if (
      environmentVersion() !== envVersion ||
      portableSecretsFile() !== file ||
      portableVersion(file) !== version
    )
      throw new Error('La configuración cambió durante la revisión; no se guarda.');
    if (
      Object.keys(changes).some(
        (key) =>
          !keys.includes(key) ||
          hasEnvOverride(key) ||
          typeof changes[key] !== 'string' ||
          !changes[key] ||
          /[\r\n\0]/.test(changes[key] as string),
      )
    )
      throw new Error('Cambios inválidos o gestionados desde entorno; no se guarda.');
    if (!Object.keys(changes).length) return false;
    writePortableFile(file, { ...original, ...changes });
    for (const [key, value] of Object.entries(changes)) syncCacheAfterWrite(key, value);
    return true;
  });
}
