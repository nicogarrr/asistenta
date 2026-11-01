import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { PreguntasPendientes } from '../src/daemon/pregunta-pendiente.js';
import { resolveDownloadsDir } from '../src/ojo-downloads.js';
import {
  DOWNLOADS_DIR_ASK,
  downloadsDirAnswer,
  downloadsDirMissingText,
  downloadsDirSavedText,
} from '../src/ojo-respuestas.js';

// Nico (1 nov): que Asistenta hable como un amigo, sin claves de la bóveda ni comandos.
const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');

describe('Descargas sin carpeta: pregunta dónde está en vez de nombrar la bóveda', () => {
  it('no menciona ojo:downloadsDir ni la bóveda al usuario', () => {
    expect(cli).not.toContain('Puedes fijar la carpeta en la bóveda con ojo:downloadsDir');
    expect(DOWNLOADS_DIR_ASK).not.toMatch(/b[oó]veda|downloadsDir|\/\w/);
    expect(DOWNLOADS_DIR_ASK).toContain('dime dónde');
    expect(cli).toContain('if (on && !st.running) askDownloadsDir(inbound);');
  });

  it('una ruta escrita tal cual es la respuesta; lo demás no', () => {
    expect(downloadsDirAnswer('D:\\Descargas')).toBe('descargas carpeta D:\\Descargas');
    expect(downloadsDirAnswer('«C:/Users/Nico/Downloads»')).toBe(
      'descargas carpeta C:/Users/Nico/Downloads',
    );
    expect(downloadsDirAnswer('/home/nico/Descargas')).toBe(
      'descargas carpeta /home/nico/Descargas',
    );
    for (const t of ['sí', 'en el disco D', 'apágalo', '', 'D:'])
      expect(downloadsDirAnswer(t), t).toBeNull();
    const p = new PreguntasPendientes();
    p.ask('c', 'ojo', { answer: downloadsDirAnswer });
    expect(p.consume('c', 'D:\\Descargas')).toEqual({
      name: 'ojo',
      args: 'descargas carpeta D:\\Descargas',
    });
  });

  it('solo guarda una carpeta que existe y lo dice en palabras normales', () => {
    const dir = mkdtempSync(`${tmpdir()}/descargas-`);
    expect(resolveDownloadsDir({ override: dir })).toBe(dir);
    expect(resolveDownloadsDir({ override: `${dir}/no-existe` })).toBeNull();
    expect(cli).toContain("await vaultSet('ojo:downloadsDir', dir);");
    expect(downloadsDirMissingText(' X:\\nada ')).toBe(
      'No encuentro la carpeta «X:\\nada». ¿Me dices otra vez dónde está, con la ruta entera?',
    );
    expect(downloadsDirSavedText('D:\\Descargas', { running: true })).toBe(
      'Hecho, ahora vigilo «D:\\Descargas». Si quieres que lo apague, dime «apágalo».',
    );
    expect(
      downloadsDirSavedText('D:\\X', { running: false, reason: 'no he podido vigilar la carpeta' }),
    ).toBe('He guardado «D:\\X», pero no he podido vigilar la carpeta.');
    expect(downloadsDirSavedText('D:\\X', null)).toBe(
      'Hecho, cuando enciendas las Descargas vigilo «D:\\X».',
    );
  });
});
