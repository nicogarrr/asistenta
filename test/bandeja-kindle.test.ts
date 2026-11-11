import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bandejaCommand } from '../src/bandeja/comando.js';
import { cardButtons } from '../src/bandeja/formato.js';
import {
  autoKindle,
  buildEpub,
  deliverToKindle,
  type KindleDeliverDeps,
  kindleable,
  kindleReplyWord,
  kindleSettings,
  readArticle,
  transcriptBlocks,
  wallReason,
} from '../src/bandeja/kindle.js';
import { BandejaQueue, type ProcesarDeps } from '../src/bandeja/procesar.js';
import { composeDigest } from '../src/bandeja/resumen.js';
import { type BandejaItem, BandejaStore, type ProcessResult } from '../src/bandeja/store.js';
import { epubToAzw3 } from '../src/books/convert.js';
import { commandFromCallback } from '../src/channels/telegram-shared.js';
import { crearPdf } from '../src/entregables/pdf.js';

const CHAT = '111';
const NOV11 = new Date('2026-11-11T09:00:00Z');

let dir: string;
let store: BandejaStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kindle-'));
  store = new BandejaStore(join(dir, 'bandeja.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Lee un zip (el del EPUB): nombre → { método, contenido }, en orden. */
function unzip(buf: Buffer): Array<{ name: string; method: number; data: string }> {
  const out: Array<{ name: string; method: number; data: string }> = [];
  let at = 0;
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const method = buf.readUInt16LE(at + 8);
    const size = buf.readUInt32LE(at + 18);
    const nameLen = buf.readUInt16LE(at + 26);
    const extra = buf.readUInt16LE(at + 28);
    const name = buf.subarray(at + 30, at + 30 + nameLen).toString('utf8');
    const start = at + 30 + nameLen + extra;
    const raw = buf.subarray(start, start + size);
    out.push({ name, method, data: (method === 0 ? raw : inflateRawSync(raw)).toString('utf8') });
    at = start + size;
  }
  return out;
}

const PARRAFO =
  'La política monetaria de los bancos centrales tiene efectos distributivos que rara vez se discuten con datos, y este artículo los repasa con cifras de los últimos veinte años en la eurozona y en Estados Unidos.';
const ARTICLE = `<!doctype html><html lang="es"><head>
<title>Lo que no te cuentan del BCE | Diario</title>
<meta property="og:title" content="Lo que no te cuentan del BCE">
<meta name="author" content="Ana Pérez">
<meta property="article:published_time" content="2026-11-10T07:30:00+01:00">
<meta property="og:site_name" content="Diario Económico">
</head><body><nav>Portada · Economía</nav><article>
<h1>Lo que no te cuentan del BCE</h1>
${Array.from({ length: 8 }, (_, i) => `<p>${PARRAFO} Punto ${i + 1}.</p>`).join('\n')}
<h2>Los datos</h2><ul><li>Inflación media: 2,1 %</li><li>Tipos: 0 % durante 8 años</li></ul>
<blockquote>«El dinero nunca es neutral»</blockquote>
${Array.from({ length: 4 }, () => `<p>${PARRAFO}</p>`).join('\n')}
</article><footer>Suscríbete</footer></body></html>`;

function article(url = 'https://diario.example/bce?utm_source=x'): BandejaItem {
  return store.add(CHAT, { kind: 'enlace', url }, NOV11, '2026-11-11').item;
}

function done(item: BandejaItem, r: Partial<ProcessResult> = {}): BandejaItem {
  store.saveResult(
    item.id,
    {
      verdict: 'imprescindible',
      score: 9,
      reason: 'r',
      ideas: [],
      costMin: 5,
      costLabel: '📰 5 min',
      extra: { basis: 'texto', source: 'diario.example' },
      ...r,
    },
    NOV11,
  );
  return store.get(item.id) as BandejaItem;
}

function deps(over: Partial<KindleDeliverDeps> = {}) {
  const sent: Array<{ name: string; bytes: Buffer; caption: string }> = [];
  const d: KindleDeliverDeps = {
    store,
    chatId: CHAT,
    fetchRaw: async () => ARTICLE,
    convert: async () => ({ ok: false, reason: 'no-converter', message: 'sin calibre' }),
    sendFile: async (bytes, name, caption) => {
      sent.push({ name, bytes, caption });
    },
    env: {},
    now: () => NOV11,
    ...over,
  };
  return { d, sent };
}

describe('kindle: EPUB', () => {
  it('artículo → EPUB con metadatos y primera página con título, autor, fecha y enlace', async () => {
    const { doc } = await readArticle(ARTICLE, 'https://diario.example/bce');
    expect(doc).toMatchObject({
      title: 'Lo que no te cuentan del BCE',
      author: 'Ana Pérez',
      date: '2026-11-10',
      source: 'Diario Económico',
      lang: 'es',
    });
    expect(doc.blocks.some((b) => b.t === 'h' && b.text === 'Los datos')).toBe(true);
    expect(doc.blocks.filter((b) => b.t === 'li').map((b) => b.text)).toEqual([
      'Inflación media: 2,1 %',
      'Tipos: 0 % durante 8 años',
    ]);
    expect(doc.blocks.some((b) => b.t === 'q')).toBe(true);
    expect(doc.blocks.some((b) => /Portada|Suscríbete/.test(b.text))).toBe(false);

    const files = unzip(buildEpub(doc, NOV11));
    // El mimetype va el primero y sin comprimir (lo exige el formato).
    expect(files[0]).toEqual({ name: 'mimetype', method: 0, data: 'application/epub+zip' });
    const byName = Object.fromEntries(files.map((f) => [f.name, f.data]));
    expect(byName['META-INF/container.xml']).toContain('OEBPS/content.opf');
    const opf = byName['OEBPS/content.opf'] ?? '';
    expect(opf).toContain('<dc:title>Lo que no te cuentan del BCE</dc:title>');
    expect(opf).toContain('<dc:creator>Ana Pérez</dc:creator>');
    expect(opf).toContain('<dc:date>2026-11-10</dc:date>');
    expect(opf).toContain('<dc:language>es</dc:language>');
    expect(opf).toContain('<dc:source>https://diario.example/bce</dc:source>');
    expect(opf).toContain('<meta property="dcterms:modified">2026-11-11T09:00:00Z</meta>');
    expect(opf).toContain('properties="nav"');
    const portada = byName['OEBPS/portada.xhtml'] ?? '';
    expect(portada).toContain('Lo que no te cuentan del BCE');
    expect(portada).toContain('Ana Pérez');
    expect(portada).toContain('10 de noviembre de 2026');
    expect(portada).toContain('https://diario.example/bce');
    expect(portada).toContain('lectura personal');
    expect(byName['OEBPS/parte1.xhtml']).toContain('<li>Tipos: 0 % durante 8 años</li>');
    expect(byName['OEBPS/toc.ncx']).toContain('<navMap>');
  });

  it('escapa lo que trae la página (un título con < & ") y el XHTML sigue bien formado', async () => {
    const { parseHTML } = await import('linkedom');
    const doc = {
      title: 'A < B & "C"',
      blocks: [{ t: 'p' as const, text: '<script>alert(1)</script> & más' }],
    };
    const files = unzip(buildEpub(doc, NOV11));
    const parte = files.find((f) => f.name === 'OEBPS/parte1.xhtml')?.data ?? '';
    expect(parte).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; más');
    expect(parte).not.toContain('<script>');
    const { DOMParser } = parseHTML('<html></html>');
    const xmlDoc = new DOMParser().parseFromString(
      files.find((f) => f.name === 'OEBPS/content.opf')?.data ?? '',
      'text/xml',
    );
    expect(xmlDoc.getElementsByTagName('dc:title')[0]?.textContent).toBe('A < B & "C"');
  });

  it('sin idioma declarado, el EPUB dice el de su texto (inglés o español)', () => {
    const en = unzip(
      buildEpub(
        {
          title: 'T',
          blocks: [
            { t: 'p', text: 'This is the way that you do it, and it is good for the work.' },
          ],
        },
        NOV11,
      ),
    ).find((f) => f.name === 'OEBPS/content.opf');
    expect(en?.data).toContain('<dc:language>en</dc:language>');
    const es = unzip(
      buildEpub(
        {
          title: 'T',
          blocks: [{ t: 'p', text: 'Esta es la forma en que se hace y es buena para el trabajo.' }],
        },
        NOV11,
      ),
    ).find((f) => f.name === 'OEBPS/content.opf');
    expect(es?.data).toContain('<dc:language>es</dc:language>');
  });

  it('la transcripción sale en párrafos de lectura, sin marcas de tiempo', () => {
    const blocks = transcriptBlocks(
      '[00:00] Hola a todos.\n[00:30] Hoy hablamos de moats.\nLínea corta\nde subtítulo.',
    );
    expect(blocks).toEqual([
      { t: 'p', text: 'Hola a todos. Hoy hablamos de moats. Línea corta de subtítulo.' },
    ]);
  });
});

describe('kindle: PDF', () => {
  it('el PDF respeta los saltos de línea (antes todo el texto salía en un solo bloque)', async () => {
    const pdf = await crearPdf({
      titulo: 'T',
      texto: 'Fuente: diario\nEnlace: https://x.example\n\nPárrafo uno.',
    });
    // Cada línea dibujada es un trozo de texto aparte en el PDF.
    const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
      getDocument: (o: { data: Uint8Array }) => {
        promise: Promise<{
          getPage: (n: number) => Promise<{
            getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
          }>;
        }>;
      };
    };
    const docu = await pdfjs.getDocument({ data: new Uint8Array(pdf) }).promise;
    const items = (await (await docu.getPage(1)).getTextContent()).items
      .map((i) => (i.str ?? '').trim())
      .filter(Boolean);
    expect(items).toEqual(['T', 'Fuente: diario', 'Enlace: https://x.example', 'Párrafo uno.']);
  });
});

describe('kindle: entrega', () => {
  it('sin Calibre: manda el EPUB, avisa UNA vez de cómo instalarlo y no lo instala', async () => {
    const item = done(article());
    const { d, sent } = deps();
    const text = await deliverToKindle({ item }, d);
    expect(sent.map((f) => f.name)).toEqual(['Lo que no te cuentan del BCE.epub']);
    expect(text).toContain('listo para el Kindle: EPUB');
    expect(text).toContain('winget install calibre.calibre');
    const again = await deliverToKindle({ item }, d);
    expect(again).not.toContain('winget');
  });

  it('con Calibre: AZW3 para el Paperwhite (por USB) y EPUB; con «pdf», también el PDF', async () => {
    const item = done(article());
    const convert = vi.fn(async () => ({ ok: true as const, azw3: Buffer.from('AZW3') }));
    const { d, sent } = deps({ convert });
    const text = await deliverToKindle({ item, pdf: true }, d);
    expect(sent.map((f) => f.name)).toEqual([
      'Lo que no te cuentan del BCE.azw3',
      'Lo que no te cuentan del BCE.epub',
      'Lo que no te cuentan del BCE.pdf',
    ]);
    expect(sent[2]?.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(text).toContain('AZW3 (Paperwhite, por USB) y EPUB + PDF');
    expect(text).not.toContain('winget');
  });

  it('el correo al Kindle está apagado por defecto; con PA_KINDLE_EMAIL va el EPUB a esa dirección', async () => {
    const item = done(article());
    const send = vi.fn(async (_account: unknown, _req: unknown) => ({ ok: true }));
    const mail = {
      account: async () => ({
        address: 'asistenta@gmail.com',
        password: 'x',
        imapHost: 'i',
        imapPort: 993,
        smtpHost: 's',
        smtpPort: 465,
      }),
      send,
    };
    const off = deps({ mail });
    expect(kindleSettings(store, {}).email).toBeNull();
    const t1 = await deliverToKindle({ item }, off.d);
    expect(send).not.toHaveBeenCalled();
    expect(t1).not.toContain('📧');

    const on = deps({ mail, env: { PA_KINDLE_EMAIL: 'nico_x@kindle.com' } });
    const t2 = await deliverToKindle({ item }, on.d);
    expect(send).toHaveBeenCalledTimes(1);
    const req = send.mock.calls[0]?.[1] as unknown as {
      to: string[];
      attachments: Array<{ filename: string }>;
    };
    expect(req.to).toEqual(['nico_x@kindle.com']);
    expect(req.attachments.map((a) => a.filename)).toEqual(['Lo que no te cuentan del BCE.epub']);
    expect(t2).toContain('📧 Enviado a tu Kindle (nico_x@kindle.com)');
    expect(t2).toContain('Documentos personales');

    // Una dirección que no es de Kindle no enciende nada; «correo off» lo apaga.
    expect(kindleSettings(store, { PA_KINDLE_EMAIL: 'otro@gmail.com' }).email).toBeNull();
    store.setMeta('kindle_email', 'off');
    expect(kindleSettings(store, { PA_KINDLE_EMAIL: 'nico_x@kindle.com' }).email).toBeNull();
  });

  it('muro de pago o página que pide sesión: el enlace y el porqué, sin ficheros', async () => {
    const walled = `<html><head><title>Exclusiva</title><script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false}</script></head><body><article>${Array.from({ length: 10 }, () => `<p>${PARRAFO}</p>`).join('')}</article></body></html>`;
    expect(wallReason(walled, 500)).toMatch(/de pago/);
    const item = done(article('https://pago.example/exclusiva'));
    const a = deps({ fetchRaw: async () => walled });
    const t = await deliverToKindle({ item }, a.d);
    expect(a.sent).toEqual([]);
    expect(t).toMatch(/no va al Kindle: la página dice que es de pago/);
    expect(t).toContain(
      '🔗 Aquí lo tienes para leerlo directamente: https://pago.example/exclusiva',
    );

    const thin = deps({
      fetchRaw: async () => '<html><body><p>Inicia sesión para seguir leyendo.</p></body></html>',
    });
    expect(await deliverToKindle({ item }, thin.d)).toMatch(/muy poco texto/);
    expect(thin.sent).toEqual([]);

    const forbidden = deps({
      fetchRaw: async () => {
        throw new Error('403 Forbidden for https://pago.example/exclusiva');
      },
    });
    expect(await deliverToKindle({ item }, forbidden.d)).toMatch(/pide sesión o suscripción/);
    expect(forbidden.sent).toEqual([]);
  });

  it('un PDF que mandó Nico va tal cual, sin rehacerlo', async () => {
    const pdf = Buffer.from('%PDF-1.7 original');
    const { item } = store.add(
      CHAT,
      { kind: 'pdf', fileId: 'F1', fileName: 'Tesis ASTS.pdf', mimeType: 'application/pdf' },
      NOV11,
      '2026-11-11',
    );
    const convert = vi.fn();
    const { d, sent } = deps({ download: async () => pdf, convert });
    const t = await deliverToKindle({ item }, d);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.bytes).toBe(pdf);
    expect(sent[0]?.name).toBe('Tesis ASTS.pdf');
    expect(convert).not.toHaveBeenCalled();
    expect(t).toContain('PDF original tal cual');
  });

  it('la transcripción guardada al procesar se usa sin volver a transcribir', async () => {
    const { item } = store.add(
      CHAT,
      { kind: 'youtube', url: 'https://youtu.be/AAAAAAAAAAA' },
      NOV11,
      '2026-11-11',
    );
    const videoText = vi.fn(async () => ({
      ok: true as const,
      meta: { title: 'Buffett 1998', author: 'Canal', durationSeconds: 5400 },
      text: '[00:00] El foso del castillo importa.\n[00:30] Y el círculo de competencia.',
      source: 'audio' as const,
    }));
    const proc: ProcesarDeps = {
      complete: async () => async () =>
        'TITULO: T\nVEREDICTO: IMPRESCINDIBLE\nNOTA: 9\nMOTIVO: m\nIDEAS:\n- a\n- b\n- c\nETIQUETAS: ninguna',
      fetchRaw: async () => '',
      videoText,
    };
    const queue = new BandejaQueue(store, proc);
    await queue.enqueue(item.id);
    expect(videoText).toHaveBeenCalledTimes(1);
    const fresh = store.get(item.id) as BandejaItem;
    expect(kindleable(fresh)).toBe(true);
    // Un vídeo 🔴 es para verlo: el automático no lo manda (el botón sí).
    expect(autoKindle(fresh)).toBe(false);
    const readable = vi.fn();
    const { d, sent } = deps({ readable });
    await deliverToKindle({ item: fresh }, d);
    expect(readable).not.toHaveBeenCalled();
    expect(videoText).toHaveBeenCalledTimes(1);
    const parte = unzip(sent[0]?.bytes as Buffer).find((f) => f.name === 'OEBPS/parte1.xhtml');
    expect(parte?.data).toContain('El foso del castillo importa. Y el círculo de competencia.');
    const portada = unzip(sent[0]?.bytes as Buffer).find((f) => f.name === 'OEBPS/portada.xhtml');
    expect(portada?.data).toContain('Transcripción del vídeo');
  });

  it('un vídeo juzgado solo por la descripción no tiene botón y, si se pide, va el enlace', async () => {
    const yt = done(
      store.add(CHAT, { kind: 'youtube', url: 'https://youtu.be/BBBBBBBBBBB' }, NOV11, '2026-11-11')
        .item,
      { extra: { basis: 'descripcion', basisReason: 'YouTube bloqueó' } },
    );
    expect(kindleable(yt)).toBe(false);
    expect(cardButtons(yt).map((b) => b.label)).not.toContain('📖 Al Kindle');
    const { d, sent } = deps();
    expect(await deliverToKindle({ item: yt }, d)).toMatch(/no tengo su transcripción/);
    expect(sent).toEqual([]);
  });
});

describe('kindle: automático solo para lo 🔴 que se lee', () => {
  it('autoKindle: 🔴 artículo sí; 🟡 no; ⏳ sin juzgar no', () => {
    expect(autoKindle(done(article('https://a.example/1')))).toBe(true);
    expect(autoKindle(done(article('https://a.example/2'), { verdict: 'ideas' }))).toBe(false);
    expect(autoKindle(article('https://a.example/3'))).toBe(false);
  });

  it('la cola avisa al terminar (onDone) con la cosa ya juzgada', async () => {
    const item = article('https://a.example/x');
    const seen: BandejaItem[] = [];
    const words = Array.from({ length: 300 }, (_, i) => `palabra${i}`).join(' ');
    const queue = new BandejaQueue(store, {
      complete: async () => async () =>
        'TITULO: T\nVEREDICTO: IMPRESCINDIBLE\nNOTA: 9\nMOTIVO: m\nIDEAS:\n- a\n- b\n- c\nETIQUETAS: ninguna',
      fetchRaw: async () => `<html><body><article><p>${words}</p></article></body></html>`,
      videoText: async () => ({ ok: false, reason: 'no' }),
      onDone: (it) => {
        seen.push(it);
      },
    });
    await queue.enqueue(item.id);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.verdict).toBe('imprescindible');
    expect(autoKindle(seen[0] as BandejaItem)).toBe(true);
    expect(store.getText(item.id)).toContain('palabra299');
  });

  it('/bandeja kindle auto on|off y correo, por Telegram', async () => {
    const base = {
      store,
      queue: {} as BandejaQueue,
      chatId: CHAT,
      now: () => NOV11,
      env: {},
    };
    expect(kindleSettings(store, {}).auto).toBe(false);
    expect((await bandejaCommand('kindle auto on', base)).text).toMatch(/léelo entero/);
    expect(kindleSettings(store, {}).auto).toBe(true);
    await bandejaCommand('kindle auto off', base);
    expect(kindleSettings(store, {}).auto).toBe(false);
    expect((await bandejaCommand('kindle correo nico@gmail.com', base)).text).toMatch(
      /@kindle\.com/,
    );
    expect(kindleSettings(store, {}).email).toBeNull();
    expect((await bandejaCommand('kindle correo nico_x@kindle.com', base)).text).toMatch(
      /remitentes aprobados/,
    );
    expect(kindleSettings(store, {}).email).toBe('nico_x@kindle.com');
    expect((await bandejaCommand('kindle', base)).text).toMatch(/encendido \(nico_x@kindle\.com\)/);
  });

  it('/bandeja kindle N llama a la entrega con esa cosa (y «pdf»)', async () => {
    const item = done(article());
    const kindle = vi.fn(async () => '📖 ok');
    const r = await bandejaCommand(`kindle ${item.id} pdf`, {
      store,
      queue: {} as BandejaQueue,
      chatId: CHAT,
      now: () => NOV11,
      kindle,
    });
    expect(r.text).toBe('📖 ok');
    expect(r.itemId).toBe(item.id);
    expect(kindle).toHaveBeenCalledWith({
      item: expect.objectContaining({ id: item.id }),
      pdf: true,
    });
    await bandejaCommand('kindle https://otro.example/a', {
      store,
      queue: {} as BandejaQueue,
      chatId: CHAT,
      now: () => NOV11,
      kindle,
    });
    expect(kindle).toHaveBeenLastCalledWith({ url: 'https://otro.example/a', pdf: false });
  });
});

describe('kindle: botones y «kindle» contestando', () => {
  it('ficha y resumen llevan «📖 Al Kindle» en lo que se lee, con callback válido', () => {
    const a = done(article());
    const labels = cardButtons(a).map((b) => b.label);
    expect(labels).toEqual(['✅ visto', '⏭️ mañana', '🗑️ fuera', '📖 Al Kindle']);
    expect(commandFromCallback(cardButtons(a)[3]?.action ?? '')).toBe(`/bandeja kindle ${a.id}`);
    const d = composeDigest([a], '2026-11-11');
    // Los tres de cada cosa primero (filas de 3 intactas), los «📖 N Kindle» detrás.
    expect(d.buttons.map((b) => b.label)).toEqual([
      `✅ ${a.id} visto`,
      `⏭️ ${a.id} mañana`,
      `🗑️ ${a.id} fuera`,
      `📖 ${a.id} Kindle`,
    ]);
  });

  it('el mensaje de una cosa se apunta para contestarle «kindle»', () => {
    const a = article();
    store.linkMessage(CHAT, '555', a.id);
    expect(store.itemForMessage(CHAT, '555')?.id).toBe(a.id);
    expect(store.itemForMessage('otro', '555')).toBeNull();
    expect(kindleReplyWord('Kindle')).toEqual({ pdf: false });
    expect(kindleReplyWord('📖')).toEqual({ pdf: false });
    expect(kindleReplyWord('mándalo al kindle!')).toEqual({ pdf: false });
    expect(kindleReplyWord('kindle pdf')).toEqual({ pdf: true });
    expect(kindleReplyWord('¿tiene kindle versión?')).toBeNull();
    expect(kindleReplyWord('kindle es mejor que kobo')).toBeNull();
  });
});

describe('kindle: Calibre (ebook-convert) con un ejecutor falso', () => {
  it('sin Calibre: no-converter, sin instalar nada', async () => {
    const run = vi.fn(async () => ({ code: 1, stderr: 'not found' }));
    const r = await epubToAzw3(Buffer.from('epub'), 'T', run, null);
    expect(r).toMatchObject({ ok: false, reason: 'no-converter' });
    expect(run).not.toHaveBeenCalled();
  });

  it('con Calibre: --output-profile kindle_pw3 a AZW3', async () => {
    const run = vi.fn(async (_cmd: string, args: string[]) => {
      writeFileSync(args[1] as string, 'AZW3DATA');
      return { code: 0, stderr: '' };
    });
    const r = await epubToAzw3(Buffer.from('epub'), 'Mi libro', run, 'ebook-convert');
    expect(r).toEqual({ ok: true, azw3: Buffer.from('AZW3DATA') });
    const args = run.mock.calls[0]?.[1] as string[];
    expect(args[0]).toMatch(/libro\.epub$/);
    expect(args[1]).toMatch(/libro\.azw3$/);
    expect(args.slice(2)).toEqual(['--output-profile', 'kindle_pw3', '--title', 'Mi libro']);
  });
});
