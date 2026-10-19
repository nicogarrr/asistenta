/**
 * Estado de la configuración de correo, sin valores. Solo dice qué falta y el paso seguro
 * para ponerlo (vault set-stdin por pipe privado en el PC); nunca pide ni muestra secretos.
 */
import { vaultGet } from '../vault.js';

type Get = (key: string) => Promise<string | null | undefined>;
const GMAIL = /^[^@\s]+@gmail\.com$/i;
const APP_PASSWORD = /^[a-zA-Z]{16}$/;

export interface MailStatus {
  read: 'ok' | 'falta' | 'invalida';
  send: 'ok' | 'falta' | 'invalida';
  sameAccount: boolean | null;
  lines: string[];
}

async function check(
  get: Get,
  scope: 'mailRead' | 'mailSend',
): Promise<[MailStatus['read'], string]> {
  const address = (await get(`${scope}:address`))?.trim() ?? '';
  const password = ((await get(`${scope}:password`)) ?? '').replace(/ /g, '');
  if (!address && !password) return ['falta', ''];
  if (!GMAIL.test(address) || !APP_PASSWORD.test(password)) return ['invalida', address];
  return ['ok', address.toLowerCase()];
}

export async function mailStatus(get: Get = vaultGet): Promise<MailStatus> {
  const [read, readAddr] = await check(get, 'mailRead');
  const [send, sendAddr] = await check(get, 'mailSend');
  const sameAccount = read === 'ok' && send === 'ok' ? readAddr === sendAddr : null;
  const lines = [
    `Lectura (avisos y lista): ${read === 'ok' ? 'configurada' : read === 'falta' ? 'falta' : 'datos no válidos'}.`,
    `Envío con tu aprobación: ${send === 'ok' ? 'configurado' : send === 'falta' ? 'falta' : 'datos no válidos'}.`,
  ];
  if (sameAccount === false)
    lines.push('Lectura y envío son cuentas distintas: el envío se rechazará.');
  if (read !== 'ok' || send !== 'ok') {
    lines.push(
      'Para activarlo, en el PC y con una contraseña de aplicación de Google NUEVA y dedicada (16 letras; no la principal): node dist/cli.js vault set-stdin mailRead:password (y mailSend:password) por pipe privado, más mailRead:address / mailSend:address con tu Gmail. No me la mandes por chat.',
    );
  }
  return { read, send, sameAccount, lines };
}
