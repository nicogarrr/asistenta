/** Comandos `pa tv ...`: setup (pairing una vez), toast, apps, launch, off. */

import { pairTv, tvRequest, tvToast } from './lgtv.js';

const TV_HOST_KEY = 'tv:host';
const TV_CLIENT_KEY = 'tv:clientKey';

async function requirePaired(): Promise<{ host: string; clientKey: string }> {
  const { vaultGet } = await import('../vault.js');
  const host = await vaultGet(TV_HOST_KEY);
  const clientKey = await vaultGet(TV_CLIENT_KEY);
  if (!host || !clientKey) {
    throw new Error(
      'Tele no emparejada: ejecuta primero `pa tv setup <ip>` con la tele encendida.',
    );
  }
  return { host, clientKey };
}

export async function tvCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'setup': {
      const host = rest[0]?.trim();
      if (!host) {
        process.stderr.write(
          'uso: pa tv setup <ip>   (tele encendida; acepta el aviso en pantalla)\n',
        );
        return 2;
      }
      process.stdout.write(
        `Emparejando con ${host}: ACEPTA el aviso en la tele con el mando (tienes 120s)...\n`,
      );
      const clientKey = await pairTv(host);
      const { vaultSetMany } = await import('../vault.js');
      await vaultSetMany({ [TV_HOST_KEY]: host, [TV_CLIENT_KEY]: clientKey });
      process.stdout.write('Tele emparejada y guardada. Prueba: pa tv toast "hola"\n');
      return 0;
    }
    case 'toast': {
      const message = rest.join(' ').trim();
      if (!message) {
        process.stderr.write('uso: pa tv toast <mensaje>\n');
        return 2;
      }
      const { host, clientKey } = await requirePaired();
      await tvToast(host, clientKey, message);
      process.stdout.write('Toast enviado.\n');
      return 0;
    }
    case 'apps': {
      const { host, clientKey } = await requirePaired();
      const res = await tvRequest(
        host,
        clientKey,
        'com.webos.applicationManager/listLaunchPoints',
        {},
      );
      const points = (res as { launchPoints?: { id: string; title: string }[] }).launchPoints ?? [];
      for (const p of points) process.stdout.write(`${p.id}\t${p.title}\n`);
      return 0;
    }
    case 'launch': {
      const appId = rest[0]?.trim();
      if (!appId) {
        process.stderr.write('uso: pa tv launch <appId>   (ids: pa tv apps)\n');
        return 2;
      }
      const { host, clientKey } = await requirePaired();
      await tvRequest(host, clientKey, 'system.launcher/launch', { id: appId });
      process.stdout.write(`Lanzada ${appId}.\n`);
      return 0;
    }
    case 'off': {
      const { host, clientKey } = await requirePaired();
      await tvRequest(host, clientKey, 'system/turnOff', {});
      process.stdout.write('Tele apagada.\n');
      return 0;
    }
    default:
      process.stderr.write('uso: pa tv <setup|toast|apps|launch|off>\n');
      return 2;
  }
}
