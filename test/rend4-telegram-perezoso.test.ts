import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as telegram from '../src/channels/telegram.js';
import * as shared from '../src/channels/telegram-shared.js';

/**
 * grammY (~35 módulos con node-fetch y whatwg-url) ya no se carga en cada arranque de
 * `pa`: cli.ts usa los ayudantes sin grammY de channels/telegram-shared.ts y trae el
 * canal (TelegramChannel o QaChannel) con import() solo al arrancar el daemon.
 */
describe('grammY solo al arrancar el canal de Telegram', () => {
  it('cli.ts no importa telegram.ts ni qa.ts como valor, y telegram-shared.ts no usa grammY', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    expect(cli).not.toMatch(
      /^\s*import\s+(?!type\b)[^;]*from\s+'\.\/channels\/(?:telegram|qa)\.js'/m,
    );
    expect(readFileSync('src/channels/telegram-shared.ts', 'utf8')).not.toMatch(/grammy/);
  });

  it('`pa ayuda` no carga grammY', () => {
    const hook = `data:text/javascript,${encodeURIComponent(
      "import{registerHooks}from'node:module';registerHooks({resolve(s,c,n){if(s==='grammy'||s.startsWith('grammy/'))process.stderr.write('GRAMMY_CARGADO\\n');return n(s,c)}});",
    )}`;
    const { FORCE_COLOR: _force, ...envWithoutColor } = process.env;
    const res = spawnSync(process.execPath, ['--import', hook, resolve('dist/cli.js'), 'ayuda'], {
      encoding: 'utf8',
      env: { ...envWithoutColor, NO_COLOR: '1' },
      timeout: 60_000,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Asistenta');
    expect(res.stderr).not.toContain('GRAMMY_CARGADO');
  });

  it('telegram.ts reexporta los mismos ayudantes (mismo objeto, mismo estado)', () => {
    expect(telegram.commandButton).toBe(shared.commandButton);
    expect(telegram.commandFromCallback).toBe(shared.commandFromCallback);
    expect(telegram.moreButton).toBe(shared.moreButton);
    expect(telegram.cacheFullReply).toBe(shared.cacheFullReply);
    expect(telegram.takeFullReply).toBe(shared.takeFullReply);
    expect(telegram.isMoreRequest).toBe(shared.isMoreRequest);
    expect(telegram.tooBigForBotDownload).toBe(shared.tooBigForBotDownload);
    expect(telegram.COMMAND_CALLBACK_PREFIX).toBe('cmd:');
    expect(telegram.MORE_CALLBACK_PREFIX).toBe('more:');
    // La copia completa guardada por un lado se lee por el otro: un solo almacén.
    shared.cacheFullReply('rend4:hilo', 'texto entero');
    expect(telegram.takeFullReply('rend4:hilo')).toBe('texto entero');
    expect(shared.takeFullReply('rend4:hilo')).toBeNull();
  });
});
