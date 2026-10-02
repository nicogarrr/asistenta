import { execFile } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { paths } from './paths.js';

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
  const tmp = `${paths.vault}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, paths.vault);
}

export function isUnlocked(): boolean {
  return cache.size > 0;
}

export function vaultExists(): boolean {
  return existsSync(paths.vault);
}

/** Create the vault with an empty secret map. Idempotent: refuses to clobber. */
export async function initVault(): Promise<void> {
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
  if (!existsSync(paths.vault)) throw new Error(`no vault at ${paths.vault}; run: pa vault init`);
  const file = JSON.parse(readFileSync(paths.vault, 'utf8')) as VaultFile;
  if (file.version !== 1) throw new Error(`unsupported vault version ${file.version}`);
  const dek = await dpapi(Buffer.from(file.wrappedDek, 'base64'), false);
  const map = JSON.parse(decrypt(file.ciphertext, dek)) as Record<string, string>;
  for (const [k, v] of Object.entries(map)) cache.set(k, v);
  return map;
}

async function saveMap(map: Record<string, string>): Promise<void> {
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

export async function vaultSet(key: string, value: string): Promise<void> {
  const map = await loadMap();
  map[key] = value;
  cache.set(key, value);
  await saveMap(map);
}

export async function vaultGet(key: string): Promise<string | undefined> {
  if (cache.has(key)) return cache.get(key);
  const map = await loadMap();
  return map[key];
}

export async function vaultDelete(key: string): Promise<boolean> {
  const map = await loadMap();
  if (!(key in map)) return false;
  delete map[key];
  cache.delete(key);
  await saveMap(map);
  return true;
}

/** Keys only, never values, so listing cannot leak a secret into a transcript. */
export async function vaultList(): Promise<string[]> {
  return Object.keys(await loadMap()).sort();
}

export function clearVaultCache(): void {
  cache.clear();
}
