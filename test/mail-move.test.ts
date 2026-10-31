import { describe, expect, it } from 'vitest';
import { CLEANUP_FOLDER, type ImapMover, moveFromInbox } from '../src/mail/move.js';
import { scanInbox } from '../src/mail/scan.js';

function fakeMover(boxes: Array<[string, string?]>, uidValidity = 7) {
  const calls: string[] = [];
  const imap: ImapMover = {
    connect: async () => {},
    mailboxOpen: async (p, o) => {
      calls.push(`open ${p} readOnly=${o.readOnly}`);
      return { uidValidity: BigInt(uidValidity) };
    },
    search: async () => [],
    fetchOne: async () => false,
    logout: async () => {
      calls.push('logout');
    },
    list: async () => boxes.map(([path, specialUse]) => ({ path, specialUse })),
    mailboxCreate: async (p) => calls.push(`create ${p}`),
    messageMove: async (uids, dest) => calls.push(`move ${uids.join(',')} -> ${dest}`),
  };
  return { imap, calls };
}

const GMAIL: Array<[string, string?]> = [
  ['INBOX'],
  ['[Gmail]/Papelera', '\\Trash'],
  ['[Gmail]/Todos', '\\All'],
];
const moves = (calls: string[]) => calls.filter((c) => c.startsWith('move'));

describe('mover correos fuera de la bandeja (nunca borrar)', () => {
  it('limpieza crea Asistenta/Limpieza si falta y mueve esos UIDs', async () => {
    const { imap, calls } = fakeMover(GMAIL);
    const r = await moveFromInbox(imap, [3, 5], 'limpieza', '7');
    expect(r).toEqual({ moved: 2, folder: CLEANUP_FOLDER });
    expect(calls).toContain('open INBOX readOnly=false');
    expect(calls).toContain(`create ${CLEANUP_FOLDER}`);
    expect(moves(calls)).toEqual([`move 3,5 -> ${CLEANUP_FOLDER}`]);
    expect(calls.at(-1)).toBe('logout');
  });

  it('no crea la carpeta si ya existe', async () => {
    const { imap, calls } = fakeMover([...GMAIL, [CLEANUP_FOLDER]]);
    await moveFromInbox(imap, [1], 'limpieza', '7');
    expect(calls.some((c) => c.startsWith('create'))).toBe(false);
  });

  it('papelera y archivo usan las carpetas especiales del servidor', async () => {
    const a = fakeMover(GMAIL);
    await moveFromInbox(a.imap, [1], 'papelera', '7');
    expect(moves(a.calls)).toEqual(['move 1 -> [Gmail]/Papelera']);
    const b = fakeMover(GMAIL);
    await moveFromInbox(b.imap, [2], 'archivar', '7');
    expect(moves(b.calls)).toEqual(['move 2 -> [Gmail]/Todos']);
  });

  it('sin carpeta de archivo o papelera no inventa otra ni borra', async () => {
    for (const target of ['archivar', 'papelera'] as const) {
      const { imap, calls } = fakeMover([['INBOX']]);
      await expect(moveFromInbox(imap, [1], target, '7')).rejects.toThrow(/no encuentro/);
      expect(moves(calls)).toEqual([]);
      expect(calls.at(-1)).toBe('logout');
    }
  });

  it('si la bandeja cambió de UIDVALIDITY no toca nada', async () => {
    const { imap, calls } = fakeMover(GMAIL, 99);
    await expect(moveFromInbox(imap, [1], 'limpieza', '7')).rejects.toThrow(/ha cambiado/);
    await expect(moveFromInbox(imap, [1], 'limpieza', '')).rejects.toThrow(/ha cambiado/);
    expect(moves(calls)).toEqual([]);
  });

  it('el escaneo (solo lectura) apunta el UIDVALIDITY de la bandeja', async () => {
    const { imap, calls } = fakeMover(GMAIL, 42);
    const box = { uidValidity: '' };
    await scanInbox(imap, { limit: 5, box });
    expect(box.uidValidity).toBe('42');
    expect(calls).toContain('open INBOX readOnly=true');
  });
});
