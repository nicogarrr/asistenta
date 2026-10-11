/** Comandos `pa tv ...`: setup (pairing una vez), toast, apps, launch, off. */

import { assertTvHost, pairTv, sanitizeTvText, tvRequest, tvToast } from './lgtv.js';

const TV_HOST_KEY = 'tv:host';
const TV_CLIENT_KEY = 'tv:clientKey';
const TV_SECURE_KEY = 'tv:secure';

async function requirePaired(): Promise<{
  host: string;
  clientKey: string;
  allowPlaintext: boolean;
}> {
  const { vaultGet } = await import('../vault.js');
  const host = await vaultGet(TV_HOST_KEY);
  const clientKey = await vaultGet(TV_CLIENT_KEY);
  if (!host || !clientKey) {
    throw new Error(
      'Tele no emparejada: ejecuta primero `pa tv setup <ip>` con la tele encendida.',
    );
  }
  // Si el pairing solo pudo ir por ws (3000), los requests siguen por ws; si
  // fue por wss, el downgrade a ws queda prohibido (ver lgtv.ts).
  return { host, clientKey, allowPlaintext: (await vaultGet(TV_SECURE_KEY)) === '0' };
}

export async function tvCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'setup': {
      const allowPlaintext = rest.includes('--allow-plaintext');
      const hostArg = rest.find((a) => !a.startsWith('--'))?.trim();
      if (!hostArg) {
        process.stderr.write(
          'uso: pa tv setup <ip> [--allow-plaintext]   (tele encendida; acepta el aviso en pantalla)\n',
        );
        return 2;
      }
      // Validar ANTES de imprimir: un host crudo podria meter controles de terminal.
      let host: string;
      try {
        host = assertTvHost(hostArg);
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        return 2;
      }
      if (allowPlaintext) {
        process.stdout.write(
          'AVISO: se acepta el canal ws://3000 SIN CIFRAR si el 3001 no abre: la client-key de emparejamiento podria viajar en claro por tu red local.\n',
        );
      }
      process.stdout.write(
        `Emparejando con ${host}: ACEPTA el aviso en la tele con el mando (tienes 120s)...\n`,
      );
      let paired: { clientKey: string; secure: boolean };
      try {
        paired = await pairTv(host, { allowPlaintext });
      } catch (err) {
        if (!allowPlaintext) {
          process.stderr.write(
            `${err instanceof Error ? err.message : String(err)}\n\n` +
              'Si la tele no abre el canal cifrado (3001), reintenta con:\n' +
              `  pa tv setup ${host} --allow-plaintext\n` +
              'solo si aceptas que la clave de emparejamiento viaje sin cifrar por tu wifi.\n',
          );
          return 1;
        }
        throw err;
      }
      const { clientKey, secure } = paired;
      const { vaultSetMany } = await import('../vault.js');
      await vaultSetMany({
        [TV_HOST_KEY]: host,
        [TV_CLIENT_KEY]: clientKey,
        [TV_SECURE_KEY]: secure ? '1' : '0',
      });
      process.stdout.write(
        secure
          ? 'Tele emparejada y guardada (canal cifrado). Prueba: pa tv toast "hola"\n'
          : 'Tele emparejada y guardada (canal ws sin cifrar: la tele no abrio el 3001).\n',
      );
      return 0;
    }
    case 'toast': {
      const message = rest.join(' ').trim();
      if (!message) {
        process.stderr.write('uso: pa tv toast <mensaje>\n');
        return 2;
      }
      const { host, clientKey, allowPlaintext } = await requirePaired();
      await tvToast(host, clientKey, message, { allowPlaintext });
      process.stdout.write('Toast enviado.\n');
      return 0;
    }
    case 'apps': {
      const { host, clientKey, allowPlaintext } = await requirePaired();
      const res = await tvRequest(
        host,
        clientKey,
        'com.webos.applicationManager/listLaunchPoints',
        {},
        { allowPlaintext },
      );
      const points = (res as { launchPoints?: { id: string; title: string }[] }).launchPoints ?? [];
      // Titulos remotos sanitizados: la tele no controla esta terminal.
      for (const p of points)
        process.stdout.write(`${sanitizeTvText(p.id)}\t${sanitizeTvText(p.title)}\n`);
      return 0;
    }
    case 'launch': {
      const appId = rest[0]?.trim();
      if (!appId) {
        process.stderr.write('uso: pa tv launch <appId>   (ids: pa tv apps)\n');
        return 2;
      }
      const { host, clientKey, allowPlaintext } = await requirePaired();
      await tvRequest(host, clientKey, 'system.launcher/launch', { id: appId }, { allowPlaintext });
      process.stdout.write(`Lanzada ${appId}.\n`);
      return 0;
    }
    case 'off': {
      const { host, clientKey, allowPlaintext } = await requirePaired();
      await tvRequest(host, clientKey, 'system/turnOff', {}, { allowPlaintext });
      process.stdout.write('Tele apagada.\n');
      return 0;
    }
    default:
      process.stderr.write('uso: pa tv <setup|toast|apps|launch|off>\n');
      return 2;
  }
}
