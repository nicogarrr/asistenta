import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { lazySchema, Type } from '../core/lazy-schema.js';
import { log } from '../log.js';
import { onDiskSpelling } from '../permissions.js';
import { recordAfterWrite, recordBeforeWrite } from '../undo.js';

const MAX_READ_BYTES = 512 * 1024;
/** Lines returned when the caller gives no `limit`; the result says how to page on. */
export const DEFAULT_READ_LINES = 2000;
/** Chars returned in one read, whatever the line count (one-line minified files). Kept under MAX_TOOL_RESULT_CHARS (24k) so the generic backstop never cuts a read result. */
export const MAX_READ_CHARS = 22_000;

/**
 * El texto de un fichero tal como lo deja Windows. Antes se leía siempre como UTF-8: un CSV
 * exportado de Excel o un .txt del Bloc de notas antiguo (ANSI, Windows-1252) llegaba con
 * «Facturaci�n», y lo que deja `comando > fichero.txt` en PowerShell 5 (UTF-16 con BOM)
 * llegaba como letras sueltas separadas por NUL. Devuelve el texto y la codificación leída.
 */
export function decodeTextFile(buf: Buffer): { text: string; encoding: string } {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'UTF-16' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'UTF-16' };
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'UTF-8' };
  }
  // UTF-16 sin BOM: texto latino con un NUL detrás de casi cada letra.
  if (buf.length >= 4 && buf.length % 2 === 0) {
    const n = Math.min(buf.length, 4096);
    let oddNul = 0;
    let evenNul = 0;
    for (let i = 0; i < n; i++) if (buf[i] === 0) i % 2 ? oddNul++ : evenNul++;
    if (oddNul > (n / 2) * 0.6 && evenNul < (n / 2) * 0.05) {
      return { text: new TextDecoder('utf-16le').decode(buf), encoding: 'UTF-16' };
    }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'UTF-8' };
  } catch {
    // No es UTF-8 válido: en un Windows en español es casi siempre ANSI (Windows-1252).
    try {
      return { text: new TextDecoder('windows-1252').decode(buf), encoding: 'Windows-1252' };
    } catch {
      return { text: buf.toString('latin1'), encoding: 'Windows-1252' };
    }
  }
}

const ReadParams = lazySchema(() =>
  Type.Object({
    path: Type.String({ description: 'File path, absolute or relative to the working directory.' }),
    offset: Type.Optional(
      Type.Number({ description: 'First line to return, 1-based. Default 1.' }),
    ),
    limit: Type.Optional(
      Type.Number({ description: 'How many lines to return. Default: everything left.' }),
    ),
  }),
);

const WriteParams = lazySchema(() =>
  Type.Object({
    path: Type.String({ description: 'File path.' }),
    content: Type.String({ description: 'Full file contents.' }),
  }),
);

const ListParams = lazySchema(() =>
  Type.Object({
    path: Type.Optional(
      Type.String({ description: 'Directory path. Defaults to the working directory.' }),
    ),
  }),
);

/**
 * Containment check. A model that resolves `../../.ssh/id_rsa` must be told no
 * explicitly, not left to the OS to fail in a confusing way. Windows accepts both
 * separators and is case-insensitive, so this compares normalised lowercase paths.
 */
/**
 * Whether a path relative to the working directory leaves it: «..», «../x», «..\\x» or
 * another drive. A name that only starts with dots («..notas.txt», «...») is inside;
 * before, `startsWith('..')` refused it as an escape.
 */
function escapes(rel: string): boolean {
  return rel === '..' || /^\.\.[\\/]/.test(rel) || isAbsolute(rel);
}

function guardPath(raw: string): string {
  const expanded = raw.replace(/^~(?=$|[\\/])/, homedir());
  const p = resolve(expanded);
  const rel = relative(process.cwd(), p);
  if (escapes(rel)) {
    throw new Error(`path escapes the working directory: ${raw}`);
  }
  // Same rule on the on-disk spelling (#1005): a symlink or junction inside the
  // working directory must not lead the read/write/list outside it.
  const disk = onDiskSpelling(p);
  if (disk !== null) {
    const root = onDiskSpelling(process.cwd()) ?? process.cwd();
    const realRel = relative(root, disk);
    if (escapes(realRel)) {
      throw new Error(`path escapes the working directory: ${raw}`);
    }
  }
  return p;
}

// Esquema al primer uso (core/lazy-schema.ts): estas tools existen al importar el módulo.
export const readTool: AgentTool<ReturnType<typeof ReadParams>> = {
  name: 'read',
  label: 'Read',
  description: [
    'Read a text file from disk (UTF-8, UTF-16 or Windows-1252/ANSI, detected; a non-UTF-8',
    'file says its encoding in the header). offset and limit work in lines, so a 50k-line',
    'log costs the same as a short one: read the slice you need instead of paying for',
    'the whole file and re-reading it. The result always reports the total line count',
    'and the range returned, so you can page without guessing.',
  ].join(' '),
  get parameters() {
    return ReadParams();
  },
  executionMode: 'parallel',
  execute: async (_id, args) => {
    const path = guardPath(args.path);
    if (!existsSync(path)) throw new Error(`no such file: ${args.path}`);
    const size = statSync(path).size;
    const { text: content, encoding } = decodeTextFile(readFileSync(path));
    // Fin de línea de Windows: el \r quedaba pegado al final de cada línea.
    const allLines = content.split(/\r?\n/);
    const total = allLines.length;

    const start = Math.max(1, Math.trunc(args.offset ?? 1));
    const wanted =
      args.limit === undefined ? DEFAULT_READ_LINES : Math.max(1, Math.trunc(args.limit));
    let end = Math.min(total, start - 1 + wanted);
    let slice = allLines.slice(start - 1, end).join('\n');
    // A minified file is one giant line, so the line budget alone does not bound it.
    if (slice.length > MAX_READ_CHARS) {
      const lines = allLines.slice(start - 1, end);
      let used = 0;
      let n = 0;
      for (const line of lines) {
        if (n > 0 && used + line.length + 1 > MAX_READ_CHARS) break;
        used += line.length + 1;
        n++;
      }
      end = start - 1 + n;
      slice = lines.slice(0, n).join('\n');
      if (slice.length > MAX_READ_CHARS) {
        slice = `${slice.slice(0, MAX_READ_CHARS)}\n[... línea cortada a ${MAX_READ_CHARS} caracteres ...]`;
      }
    }

    // The line budget is the real cost control. The old hard byte cap refused to
    // read anything over 512KB at all, which turned "look at line 9000 of this log"
    // into a shell pipeline; now a large file is paged instead of refused.
    if (size > MAX_READ_BYTES && args.limit === undefined && args.offset === undefined) {
      log.warn('read of a large file with no range, returning only the first page', {
        path,
        bytes: size,
      });
    }
    log.debug('read', { path, bytes: size, from: start, to: end, total });

    const more = end < total;
    const enc = encoding === 'UTF-8' ? '' : `, ${encoding}`;
    const header = `<file path="${args.path}" lines ${start}-${Math.min(end, total)} of ${total} (${size} bytes${enc})${
      more ? ` — ${total - end} lines left, call read again with offset ${end + 1}` : ''
    }>`;
    return {
      // Fenced as file data, same reason as shell output: file contents are the
      // most common place for an injected instruction to hide.
      content: [{ type: 'text', text: `${header}\n${slice}\n</file>` }],
      details: { path, bytes: size, from: start, to: end, totalLines: total, hasMore: more },
    };
  },
};

export const writeTool: AgentTool<ReturnType<typeof WriteParams>> = {
  name: 'write',
  label: 'Write',
  description:
    'Write a UTF-8 text file, creating parent directories as needed. Overwrites without warning.',
  get parameters() {
    return WriteParams();
  },
  executionMode: 'sequential',
  execute: async (_id, args) => {
    const path = guardPath(args.path);
    const undoEntry = recordBeforeWrite(path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, args.content, 'utf8');
    recordAfterWrite(args.content, undoEntry);
    log.info('write', { path, bytes: args.content.length });
    return {
      content: [{ type: 'text', text: `Wrote ${args.content.length} bytes to ${args.path}` }],
      details: { path, bytes: args.content.length },
    };
  },
};

export const listTool: AgentTool<ReturnType<typeof ListParams>> = {
  name: 'list',
  label: 'List',
  description: 'List the entries in a directory.',
  get parameters() {
    return ListParams();
  },
  executionMode: 'parallel',
  execute: async (_id, args) => {
    const path = guardPath(args.path ?? '.');
    const items = readdirSync(path, { withFileTypes: true })
      .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
      .sort();
    return {
      content: [{ type: 'text', text: items.join('\n') || '(empty)' }],
      details: { path, count: items.length },
    };
  },
};

export const fsTools = [readTool, writeTool, listTool] as const;
