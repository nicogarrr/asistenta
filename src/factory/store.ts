/**
 * One directory per factory tool under `<state>/factory/<id>/`:
 *
 * - `TOOL.md`  - YAML-ish frontmatter (flat scalars, like skills) plus a
 *   `## Notes` section. Editable by the user at 2am: a tool you cannot read
 *   or fix by hand is a tool nobody can trust.
 * - `tool.js`  - the authored ESM module (see runner.ts for the contract).
 * - `test.log` - stdout/stderr of the last subprocess test.
 *
 * `uninstall` never deletes: the directory stays with status `disabled`, so
 * what ran on the machine remains auditable.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { paths } from '../paths.js';
import {
  FACTORY_ID,
  type FactoryToolContract,
  type FactoryToolMeta,
  type FactoryToolStatus,
  MAX_FACTORY_ID_LENGTH,
} from './types.js';

const STATUSES: FactoryToolStatus[] = ['built', 'tested', 'installed', 'disabled'];

export function factoryRoot(): string {
  return join(paths.state, 'factory');
}

export function factoryDir(id: string): string {
  return join(factoryRoot(), id);
}

export function assertFactoryId(id: string): void {
  if (!FACTORY_ID.test(id) || id.length > MAX_FACTORY_ID_LENGTH) {
    throw new Error(
      `invalid factory tool id: ${JSON.stringify(id)} (slug en minusculas, ej. "euro-a-pesetas")`,
    );
  }
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function serialize(meta: FactoryToolMeta, notes: string): string {
  const q = (v: string) => JSON.stringify(v);
  return [
    '---',
    `id: ${meta.id}`,
    `name: ${q(meta.name)}`,
    `description: ${q(meta.description)}`,
    `whenToUse: ${q(meta.whenToUse)}`,
    `version: ${meta.version}`,
    `status: ${meta.status}`,
    `createdAt: ${meta.createdAt}`,
    `updatedAt: ${meta.updatedAt}`,
    `codeSha256: ${meta.codeSha256}`,
    `testedSha256: ${meta.testedSha256 ?? 'null'}`,
    `lastTestAt: ${meta.lastTestAt ?? 'null'}`,
    `lastTestOk: ${meta.lastTestOk}`,
    `contract: ${meta.contract ? JSON.stringify(meta.contract) : 'null'}`,
    '---',
    '',
    '## Notes',
    '',
    notes.trim() ? notes.trim() : '(sin notas)',
    '',
  ].join('\n');
}

function unq(v: string): string {
  const t = v.trim();
  if (t.startsWith('"')) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t;
    }
  }
  return t;
}

function parseContract(raw: string | undefined): FactoryToolContract | null {
  if (!raw || raw === 'null') return null;
  try {
    const c = JSON.parse(raw) as Partial<FactoryToolContract>;
    if (
      c &&
      typeof c.name === 'string' &&
      typeof c.description === 'string' &&
      c.parameters &&
      typeof c.parameters === 'object'
    ) {
      return {
        name: c.name,
        description: c.description,
        parameters: c.parameters as Record<string, unknown>,
      };
    }
  } catch {
    /* corrupt contract entry */
  }
  return null;
}

export function readFactoryTool(
  id: string,
): { meta: FactoryToolMeta; code: string; notes: string } | null {
  assertFactoryId(id);
  const dir = factoryDir(id);
  const mdPath = join(dir, 'TOOL.md');
  const jsPath = join(dir, 'tool.js');
  if (!existsSync(mdPath) || !existsSync(jsPath)) return null;
  const md = readFileSync(mdPath, 'utf8');
  const fm = md.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) throw new Error(`TOOL.md corrupto en ${id}: falta frontmatter`);
  const kv = new Map<string, string>();
  for (const line of (fm[1] ?? '').split('\n')) {
    const m = line.match(/^([a-zA-Z0-9]+):\s?(.*)$/);
    if (m && m[1] !== undefined) kv.set(m[1], m[2] ?? '');
  }
  const status = (kv.get('status') ?? 'built') as FactoryToolStatus;
  if (!STATUSES.includes(status)) throw new Error(`TOOL.md corrupto en ${id}: status ${status}`);
  const nullStr = (v: string | undefined) => (!v || v === 'null' ? null : v);
  const meta: FactoryToolMeta = {
    id: kv.get('id') ?? id,
    name: unq(kv.get('name') ?? '""'),
    description: unq(kv.get('description') ?? '""'),
    whenToUse: unq(kv.get('whenToUse') ?? '""'),
    version: parseVersion(kv.get('version'), id),
    status,
    createdAt: kv.get('createdAt') ?? '',
    updatedAt: kv.get('updatedAt') ?? '',
    codeSha256: kv.get('codeSha256') ?? '',
    testedSha256: nullStr(kv.get('testedSha256')),
    lastTestAt: nullStr(kv.get('lastTestAt')),
    lastTestOk: kv.get('lastTestOk') === 'true',
    contract: parseContract(kv.get('contract')),
  };
  const notesIdx = md.indexOf('## Notes');
  const notes = notesIdx >= 0 ? md.slice(notesIdx + 8).trim() : '';
  return { meta, code: readFileSync(jsPath, 'utf8'), notes };
}

/** `version` must be a positive integer; anything else means a corrupt TOOL.md. */
function parseVersion(raw: string | undefined, id: string): number {
  if (raw === undefined) return 1;
  const v = raw.trim();
  if (!/^[1-9][0-9]{0,8}$/.test(v)) throw new Error(`TOOL.md corrupto en ${id}: version ${v}`);
  return Number(v);
}

export function writeFactoryTool(meta: FactoryToolMeta, code: string, notes: string): void {
  assertFactoryId(meta.id);
  const dir = factoryDir(meta.id);
  mkdirSync(dir, { recursive: true });
  // Atomic-ish writes: tmp + rename, so a crash mid-write cannot leave a
  // half-written tool.js that the loader would import at startup.
  // Unique temp names: two writers (daemon + `pa`, or two saves at the same
  // moment) must never share — and steal — each other's temp file.
  const tag = `${process.pid}.${randomUUID()}`;
  const tmpMd = join(dir, `.TOOL.md.${tag}.tmp`);
  const tmpJs = join(dir, `.tool.js.${tag}.tmp`);
  try {
    writeFileSync(tmpMd, serialize(meta, notes));
    writeFileSync(tmpJs, code);
    renameSync(tmpMd, join(dir, 'TOOL.md'));
    renameSync(tmpJs, join(dir, 'tool.js'));
  } finally {
    rmSync(tmpMd, { force: true });
    rmSync(tmpJs, { force: true });
  }
}

export function writeFactoryMeta(meta: FactoryToolMeta, notes: string): void {
  const current = readFactoryTool(meta.id);
  if (!current) throw new Error(`factory tool desconocida: ${meta.id}`);
  writeFactoryTool(meta, current.code, notes);
}

export function listFactoryTools(): FactoryToolMeta[] {
  const root = factoryRoot();
  if (!existsSync(root)) return [];
  const out: FactoryToolMeta[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !FACTORY_ID.test(entry.name)) continue;
    try {
      const t = readFactoryTool(entry.name);
      if (t) out.push(t.meta);
    } catch {
      /* a corrupt tool must not break the listing */
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function writeFactoryTestLog(id: string, text: string): void {
  assertFactoryId(id);
  const dir = factoryDir(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'test.log'), text);
}
