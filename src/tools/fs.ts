import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { log } from '../log.js';
import { onDiskSpelling } from '../permissions.js';
import { recordAfterWrite, recordBeforeWrite } from '../undo.js';

const MAX_READ_BYTES = 512 * 1024;
/** Lines returned when the caller gives no `limit`; the result says how to page on. */
export const DEFAULT_READ_LINES = 2000;
/** Chars returned in one read, whatever the line count (one-line minified files). Kept under MAX_TOOL_RESULT_CHARS (24k) so the generic backstop never cuts a read result. */
export const MAX_READ_CHARS = 22_000;

const ReadParams = Type.Object({
  path: Type.String({ description: 'File path, absolute or relative to the working directory.' }),
  offset: Type.Optional(Type.Number({ description: 'First line to return, 1-based. Default 1.' })),
  limit: Type.Optional(
    Type.Number({ description: 'How many lines to return. Default: everything left.' }),
  ),
});

const WriteParams = Type.Object({
  path: Type.String({ description: 'File path.' }),
  content: Type.String({ description: 'Full file contents.' }),
});

const ListParams = Type.Object({
  path: Type.Optional(
    Type.String({ description: 'Directory path. Defaults to the working directory.' }),
  ),
});

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

export const readTool: AgentTool<typeof ReadParams> = {
  name: 'read',
  label: 'Read',
  description: [
    'Read a UTF-8 text file from disk. offset and limit work in lines, so a 50k-line',
    'log costs the same as a short one: read the slice you need instead of paying for',
    'the whole file and re-reading it. The result always reports the total line count',
    'and the range returned, so you can page without guessing.',
  ].join(' '),
  parameters: ReadParams,
  executionMode: 'parallel',
  execute: async (_id, args) => {
    const path = guardPath(args.path);
    if (!existsSync(path)) throw new Error(`no such file: ${args.path}`);
    const size = statSync(path).size;
    const content = readFileSync(path, 'utf8');
    const allLines = content.split('\n');
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
    const header = `<file path="${args.path}" lines ${start}-${Math.min(end, total)} of ${total} (${size} bytes)${
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

export const writeTool: AgentTool<typeof WriteParams> = {
  name: 'write',
  label: 'Write',
  description:
    'Write a UTF-8 text file, creating parent directories as needed. Overwrites without warning.',
  parameters: WriteParams,
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

export const listTool: AgentTool<typeof ListParams> = {
  name: 'list',
  label: 'List',
  description: 'List the entries in a directory.',
  parameters: ListParams,
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
