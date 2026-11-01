/**
 * Mover correos fuera de la bandeja de entrada: a «Asistenta/Limpieza», al archivo o a la
 * papelera. Nunca borra para siempre (no hay EXPUNGE ni messageDelete aquí): todo lo movido
 * se puede recuperar desde Gmail. Solo lo llama la limpieza, con el lote exacto aprobado.
 */
import type { ImapLike } from './scan.js';

export type MoveTarget = 'limpieza' | 'archivar' | 'papelera';

export const CLEANUP_FOLDER = 'Asistenta/Limpieza';

export const MOVE_TARGET_LABEL: Record<MoveTarget, string> = {
  limpieza: `mover a ${CLEANUP_FOLDER}`,
  archivar: 'archivar',
  papelera: 'mandar a la papelera (recuperable)',
};

/** Lo de ImapFlow que hace falta para mover (los tests pasan uno falso). */
export interface ImapMover extends ImapLike {
  list(): Promise<Array<{ path: string; specialUse?: string }>>;
  mailboxCreate(path: string): Promise<unknown>;
  messageMove(range: number[], destination: string, opts: { uid: true }): Promise<unknown>;
}

/** El valor UIDVALIDITY que devuelve mailboxOpen, como texto (o '' si no viene). */
export function uidValidityOf(box: unknown): string {
  const v = (box as { uidValidity?: unknown } | null)?.uidValidity;
  return typeof v === 'bigint' || typeof v === 'number' || typeof v === 'string' ? String(v) : '';
}

async function folderFor(client: ImapMover, target: MoveTarget): Promise<string> {
  const boxes = await client.list();
  if (target === 'limpieza') {
    if (!boxes.some((b) => b.path === CLEANUP_FOLDER)) await client.mailboxCreate(CLEANUP_FOLDER);
    return CLEANUP_FOLDER;
  }
  const wanted = target === 'papelera' ? ['\\Trash'] : ['\\All', '\\Archive'];
  const found = boxes.find((b) => b.specialUse && wanted.includes(b.specialUse));
  if (!found)
    throw new Error(
      target === 'papelera'
        ? 'no encuentro la papelera del correo'
        : 'no encuentro la carpeta de archivo del correo',
    );
  return found.path;
}

/**
 * Mueve exactamente estos UIDs de INBOX. Si la bandeja cambió de UIDVALIDITY desde la vista
 * previa, los números ya no son los mismos correos: no se toca nada.
 */
export async function moveFromInbox(
  client: ImapMover,
  uids: readonly number[],
  target: MoveTarget,
  expectedUidValidity: string,
): Promise<{ moved: number; folder: string }> {
  try {
    await client.connect();
    const box = await client.mailboxOpen('INBOX', { readOnly: false });
    const now = uidValidityOf(box);
    if (!expectedUidValidity || now !== expectedUidValidity)
      throw new Error('la bandeja ha cambiado desde la vista previa; vuelve a pedirme la lista');
    const folder = await folderFor(client, target);
    if (uids.length) await client.messageMove([...uids], folder, { uid: true });
    return { moved: uids.length, folder };
  } finally {
    await client.logout().catch(() => {});
  }
}
