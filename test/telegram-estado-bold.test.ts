import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isStatusTitle, marksWithTitles, telegramHtml } from '../src/channels/formatters.js';
import { formatStatus } from '../src/status.js';

/**
 * /estado con cabeceras en negrita (como /recordatorios y /agenda, #593): la primera
 * línea y «Esta conversación:» van en <b>; el resto (herramientas, errores del log,
 * proyecto) se escapa, así que un `**` o un acento grave en un error nunca formatea.
 */
const status = formatStatus({
  version: '1.2.3',
  node: 'v24.1.0',
  uptimeMs: 3_600_000,
  tools: [
    { name: 'Telegram', ok: true },
    { name: 'ffmpeg (/watch)', ok: false, note: 'no **instalado**' },
  ],
  log: { errors: 1, warns: 0, recentErrors: ['fallo en `x` **raro**'] } as never,
  pageWatches: 2,
  conversation: ['Proyecto: ninguno', 'Modelo: m1'],
});

describe('/estado con títulos en negrita', () => {
  it('reconoce solo las cabeceras', () => {
    const titles = status.split('\n').filter(isStatusTitle);
    expect(titles).toHaveLength(2);
    expect(titles[0]).toMatch(/^Asistenta 1\.2\.3 /);
    expect(titles[1]).toBe('Esta conversación:');
    expect(isStatusTitle('Asistenta dice hola')).toBe(false);
    expect(isStatusTitle('- Esta conversación:')).toBe(false);
  });

  it('en HTML: cabeceras en <b>, contenido escapado y sin negritas colaterales', () => {
    const html = telegramHtml(marksWithTitles(status, isStatusTitle));
    expect(html).toMatch(
      /^<b>Asistenta 1\.2\.3 \(Node v24\.1\.0\), encendida desde hace [^<]+<\/b>\n/,
    );
    expect(html).toContain('<b>Esta conversación:</b>');
    expect(html.match(/<b>/g)).toHaveLength(2);
    expect(html).not.toContain('<code>');
    expect(html).toContain('no *\u2060*instalado*\u2060*');
  });

  it('cmdEstado manda el texto con marksWithTitles(…, isStatusTitle) y formato marks', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('const cmdEstado = async'));
    expect(body.slice(0, 6000)).toContain(
      "await say(inbound, marksWithTitles(text, isStatusTitle), { quote: true, format: 'marks' });",
    );
  });
});
