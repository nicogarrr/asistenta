import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalKey, detectCapture, explicitCapture, kindOfUrl } from '../src/bandeja/captura.js';
import { bandejaCommand, captureAndAck, captureOn } from '../src/bandeja/comando.js';
import { cardText, itemButtons, linkLines, scoreLabel } from '../src/bandeja/formato.js';
import { goodreadsLine, goodreadsLookup, parseGoodreadsSearch } from '../src/bandeja/goodreads.js';
import {
  BandejaQueue,
  enclosureFor,
  type ProcesarDeps,
  parseSplit,
  parseYoutubeSearch,
  processItem,
  titleOverlap,
} from '../src/bandeja/procesar.js';
import {
  _resetDigestForTests,
  bandejaMaxMinutes,
  composeDigest,
  digestItems,
  nextDay,
  parseHora,
  runDigestIfDue,
  sendDigest,
} from '../src/bandeja/resumen.js';
import { BandejaStore } from '../src/bandeja/store.js';
import { parseVerdict } from '../src/bandeja/veredicto.js';
import { buildKeyboard } from '../src/channels/telegram.js';
import { commandFromCallback } from '../src/channels/telegram-shared.js';

const CHAT = '111';
const GR_HTML = readFileSync(join(__dirname, 'fixtures', 'goodreads-search.html'), 'utf8');

describe('bandeja: regla de captura', () => {
  it('un enlace a secas va a la bandeja; con una frase tuya, no', () => {
    expect(detectCapture({ text: 'https://youtu.be/EWvNQjAaOHw' })).toEqual([
      { kind: 'youtube', url: 'https://youtu.be/EWvNQjAaOHw' },
    ]);
    expect(detectCapture({ text: 'resúmeme esto https://youtu.be/EWvNQjAaOHw' })).toBeNull();
    expect(detectCapture({ text: '¿qué opinas? https://x.com/a/status/1234567' })).toBeNull();
    expect(detectCapture({ text: 'hola' })).toBeNull();
  });

  it('varios enlaces en un mensaje: uno por enlace, con su tipo', () => {
    const got = detectCapture({
      text: 'https://www.youtube.com/watch?v=OKV4yyLOV2c\nhttps://x.com/redrum_2001/status/2118435499480072225?s=48\nhttps://open.spotify.com/episode/2sDBCcGpgbJ0baMzHH8u37',
    });
    expect(got?.map((c) => c.kind)).toEqual(['youtube', 'x', 'enlace']);
  });

  it('PDF o foto sin pie: a la bandeja; con pie: conversación', () => {
    expect(
      detectCapture({
        text: '',
        documentFileId: 'F',
        documentMimeType: 'application/pdf',
        documentName: 'tesis.pdf',
      }),
    ).toEqual([
      {
        kind: 'pdf',
        title: 'tesis.pdf',
        fileId: 'F',
        fileName: 'tesis.pdf',
        mimeType: 'application/pdf',
      },
    ]);
    expect(
      detectCapture({
        text: '¿qué opinas?',
        documentFileId: 'F',
        documentMimeType: 'application/pdf',
      }),
    ).toBeNull();
    expect(detectCapture({ text: '', photoFileId: 'P' })?.[0]?.kind).toBe('imagen');
    expect(detectCapture({ text: '¿esto qué es?', photoFileId: 'P' })).toBeNull();
  });

  it('reenvío con enlace: se guarda con el texto del otro como nota; con comentario tuyo, no', () => {
    const fwd = detectCapture({
      text: '[Mensaje reenviado de Canal X]\nHilo buenísimo sobre ASTS https://x.com/u/status/123456789',
      forwardedFrom: '[Mensaje reenviado de Canal X]',
    });
    expect(fwd?.[0]?.kind).toBe('x');
    expect(fwd?.[0]?.note).toContain('Hilo buenísimo');
    expect(
      detectCapture({
        text: '[Mensaje reenviado de Ana]\nhttps://a.com/x\n[Fin del mensaje reenviado; lo que sigue lo escribe el dueño]\n¿lo miras?',
        forwardedFrom: '[Mensaje reenviado de Ana]',
      }),
    ).toBeNull();
    // Un reenvío de texto sin enlace es conversación.
    expect(
      detectCapture({ text: '[Mensaje reenviado de Ana]\n¿quedamos?', forwardedFrom: 'x' }),
    ).toBeNull();
  });

  it('no captura respuestas, notas de voz ni grupos', () => {
    expect(detectCapture({ text: 'https://a.com/b', replyToMessageId: '5' })).toBeNull();
    expect(detectCapture({ text: '', audioFileId: 'A' })).toBeNull();
    expect(detectCapture({ text: 'https://a.com/b', isGroup: true })).toBeNull();
  });

  it('«libro: X» guarda un libro, también con la captura apagada; una pregunta no', () => {
    expect(detectCapture({ text: 'libro: El nombre del viento' })).toEqual([
      { kind: 'libro', title: 'El nombre del viento' },
    ]);
    expect(detectCapture({ text: '📚 Sapiens, Harari' }, { auto: false })?.[0]?.title).toBe(
      'Sapiens, Harari',
    );
    expect(detectCapture({ text: 'libro: ¿cuál me recomiendas?' })).toBeNull();
    expect(detectCapture({ text: 'https://a.com/b' }, { auto: false })).toBeNull();
  });

  it('/bandeja a mano: enlace con nota, libro o texto suelto', () => {
    expect(explicitCapture('https://a.com/b para el viernes')).toEqual([
      { kind: 'enlace', url: 'https://a.com/b', note: 'para el viernes' },
    ]);
    expect(explicitCapture('libro Los pilares de la tierra')?.[0]).toEqual({
      kind: 'libro',
      title: 'Los pilares de la tierra',
    });
    expect(explicitCapture('idea: comparar ASTS con Iridium')?.[0]?.kind).toBe('texto');
    expect(kindOfUrl('https://www.goodreads.com/book/show/6483211-el-nombre-del-viento')).toBe(
      'libro',
    );
    expect(kindOfUrl('https://example.com/paper.pdf')).toBe('pdf');
  });

  it('clave canónica: el mismo vídeo por youtu.be y por watch?v= es el mismo', () => {
    expect(canonicalKey('https://youtu.be/7Z6x-Ov1smU?is=DZ22iynbQYl-rLb4')).toBe('yt:7Z6x-Ov1smU');
    expect(canonicalKey('https://www.youtube.com/watch?v=7Z6x-Ov1smU&t=30')).toBe('yt:7Z6x-Ov1smU');
    expect(canonicalKey('https://x.com/redrum_2001/status/2118435499480072225?a=1&s=48')).toBe(
      'x:2118435499480072225',
    );
    expect(canonicalKey('https://www.elpais.com/a/b/?utm_source=tw&id=3#x')).toBe(
      'elpais.com/a/b?id=3',
    );
  });
});

describe('bandeja: veredicto del modelo', () => {
  const temas = ['ASTS', 'Alibaba', 'inteligencia artificial'];
  it('lee el formato fijo', () => {
    const v = parseVerdict(
      [
        'TITULO: Buffett en Florida 1998',
        'VEREDICTO: IMPRESCINDIBLE',
        'NOTA: 9/10',
        'MOTIVO: Una clase magistral de inversión que el resumen no puede dar.',
        'IDEAS:',
        '- Círculo de competencia',
        '• Foso económico',
        '3) Margen de seguridad',
        'ETIQUETAS: ASTS, cripto',
      ].join('\n'),
      temas,
    );
    expect(v).toEqual({
      title: 'Buffett en Florida 1998',
      verdict: 'imprescindible',
      score: 9,
      reason: 'Una clase magistral de inversión que el resumen no puede dar.',
      ideas: ['Círculo de competencia', 'Foso económico', 'Margen de seguridad'],
      tags: ['ASTS'],
    });
  });

  it('tolera emoji, decimales y Markdown; la primera palabra manda', () => {
    expect(parseVerdict('**VEREDICTO:** 🟡 ideas\n**NOTA:** 6,6')?.score).toBe(7);
    expect(parseVerdict('VEREDICTO: IDEAS (no hace falta verlo entero)\nNOTA: 6')?.verdict).toBe(
      'ideas',
    );
    expect(parseVerdict('VEREDICTO: ⚪ paja\nNOTA: 2')?.verdict).toBe('paja');
    expect(parseVerdict('Veredicto: Paja, descartar')?.score).toBe(3);
  });

  it('veredicto y nota cuadran: 🔴 con menos de 7 es 🟡, ⚪ con 6 o más es 🟡', () => {
    expect(parseVerdict('VEREDICTO: IMPRESCINDIBLE\nNOTA: 6')?.verdict).toBe('ideas');
    expect(parseVerdict('VEREDICTO: PAJA\nNOTA: 6')?.verdict).toBe('ideas');
    expect(parseVerdict('VEREDICTO: IMPRESCINDIBLE\nNOTA: 7')?.verdict).toBe('imprescindible');
    expect(parseVerdict('VEREDICTO: PAJA\nNOTA: 4')?.verdict).toBe('paja');
  });

  it('solo nota: veredicto por la nota; sin nada: null (nunca inventado)', () => {
    expect(parseVerdict('NOTA: 8')?.verdict).toBe('imprescindible');
    expect(parseVerdict('NOTA: 5')?.verdict).toBe('ideas');
    expect(parseVerdict('NOTA: 3')?.verdict).toBe('paja');
    expect(parseVerdict('Es un vídeo interesante sobre bolsa.')).toBeNull();
    expect(parseVerdict('')).toBeNull();
  });
});

describe('bandeja: Goodreads', () => {
  it('lee la nota y el número de valoraciones del primer resultado', () => {
    expect(parseGoodreadsSearch(GR_HTML)).toEqual({
      title: 'El nombre del viento (Crónica del asesino de reyes, #1)',
      author: 'Patrick Rothfuss',
      rating: 4.52,
      ratings: 1126819,
      url: 'https://www.goodreads.com/book/show/6483211-el-nombre-del-viento',
    });
  });

  it('N/D con motivo si bloquea, no contesta o no lo encuentra (nunca una nota inventada)', async () => {
    const blocked = await goodreadsLookup(async () => {
      throw new Error('403 Forbidden for https://www.goodreads.com/search?q=x');
    }, 'x');
    expect(blocked).toEqual({ ok: false, reason: 'Goodreads bloqueó la consulta' });
    expect(goodreadsLine(blocked)).toBe('⭐ Goodreads: N/D (Goodreads bloqueó la consulta)');
    const waf = await goodreadsLookup(
      async () =>
        '<html><head><title></title></head><script src="https://x.token.awswaf.com/challenge.js"></script></html>',
      'x',
    );
    expect(waf).toEqual({
      ok: false,
      reason: 'Goodreads bloqueó la consulta (verificación anti-bots)',
    });
    const none = await goodreadsLookup(async () => '<html><body>No results</body></html>', 'zzz');
    expect(none.ok).toBe(false);
    expect(none.reason).toBe('no encontré el libro en Goodreads');
    expect(none.rating).toBeUndefined();
    const ok = await goodreadsLookup(async () => GR_HTML, 'el nombre del viento');
    expect(goodreadsLine(ok)).toBe('⭐ Goodreads 4,52/5 (1,1 M valoraciones)');
  });
});

let dir: string;
let store: BandejaStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bandeja-'));
  store = new BandejaStore(join(dir, 'bandeja.db'));
  _resetDigestForTests();
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const NOV11 = new Date('2026-11-11T09:00:00Z');

function addDone(
  url: string,
  verdict: 'imprescindible' | 'ideas' | 'paja',
  score: number,
  day = '2026-11-11',
  costMin = 10,
) {
  const { item } = store.add(CHAT, { kind: kindOfUrl(url), url }, NOV11, day);
  store.saveResult(
    item.id,
    {
      title: `Cosa ${score}`,
      verdict,
      score,
      reason: `porque ${score}`,
      ideas: ['idea uno', 'idea dos'],
      costMin,
      costLabel: `🎬 ${costMin} min`,
      extra: { source: 'YouTube' },
    },
    NOV11,
  );
  return item.id;
}

describe('bandeja: guardar y deduplicar', () => {
  it('el mismo vídeo por otro enlace no se guarda dos veces', () => {
    const a = store.add(
      CHAT,
      { kind: 'youtube', url: 'https://youtu.be/7Z6x-Ov1smU?is=abc' },
      NOV11,
      '2026-11-11',
    );
    const b = store.add(
      CHAT,
      { kind: 'youtube', url: 'https://www.youtube.com/watch?v=7Z6x-Ov1smU' },
      NOV11,
      '2026-11-11',
    );
    expect(a.dup).toBe(false);
    expect(b.dup).toBe(true);
    expect(b.item.id).toBe(a.item.id);
    expect(store.countDay(CHAT, '2026-11-11')).toBe(1);
  });

  it('el aviso dice cuántas hay hoy y lleva «⚡ Míralo ya» y «🗑️ Quitar»', () => {
    const queue = { enqueue: async () => {} } as unknown as BandejaQueue;
    const r = captureAndAck({ store, queue, chatId: CHAT, now: () => NOV11, env: {} }, [
      { kind: 'youtube', url: 'https://youtu.be/EWvNQjAaOHw' },
    ]);
    expect(r.text).toMatch(/^📥 🎬 guardado en la bandeja · 1 hoy\. Te digo a las 21:30/);
    expect(r.buttons?.map((b) => b.label)).toEqual(['⚡ Míralo ya', '🗑️ Quitar']);
    expect(r.buttons?.map((b) => commandFromCallback(b.action))).toEqual([
      '/bandeja ahora 1',
      '/bandeja descartar 1',
    ]);
  });
});

describe('bandeja: resumen de la noche', () => {
  it('ordena 🔴 → 🟡 → ⚪, junta la paja y pone botones de 3 por cosa', () => {
    const p = addDone('https://a.com/paja', 'paja', 2, '2026-11-11', 30);
    const y = addDone('https://a.com/ideas', 'ideas', 6);
    const r = addDone('https://youtu.be/AAAAAAAAAAA', 'imprescindible', 9, '2026-11-11', 45);
    const d = composeDigest(digestItems(store, CHAT, '2026-11-11'), '2026-11-11');
    const at = (s: string) => d.text.indexOf(s);
    expect(at(`#${r} `)).toBeGreaterThan(0);
    expect(at(`#${r} `)).toBeLessThan(at(`#${y} `));
    expect(at(`#${y} `)).toBeLessThan(at(`#${p} `));
    expect(d.text).toContain('3 cosas · 1 🔴 · 1 🟡 · 1 ⚪');
    expect(d.text).toContain('Lo imprescindible te lleva ~45 min');
    expect(d.text).toContain('Te ahorro ~30 min de paja');
    expect(d.text).toContain('👉 míralo entero');
    expect(d.buttons.map((b) => b.label)).toEqual([
      `✅ ${r} visto`,
      `⏭️ ${r} mañana`,
      `🗑️ ${r} fuera`,
      `✅ ${y} visto`,
      `⏭️ ${y} mañana`,
      `🗑️ ${y} fuera`,
      // El artículo se lee: «📖 Al Kindle» detrás (el vídeo sin transcripción, no).
      `📖 ${y} Kindle`,
      '🧹 Quitar la paja',
    ]);
    for (const b of d.buttons) expect(commandFromCallback(b.action)).toMatch(/^\/bandeja /);
  });

  it('lo 🔴 sin ver pasa al día siguiente marcado; lo 🟡 ya resumido no vuelve', async () => {
    const r = addDone('https://youtu.be/AAAAAAAAAAA', 'imprescindible', 9);
    const y = addDone('https://a.com/ideas', 'ideas', 6);
    const sent: string[] = [];
    const deps = {
      store,
      now: () => new Date('2026-11-11T20:31:00Z'),
      owner: () => CHAT,
      send: async (_c: string, text: string) => {
        sent.push(text);
        return true;
      },
      env: {},
    };
    expect(await runDigestIfDue({ ...deps, now: () => new Date('2026-11-11T20:00:00Z') })).toBe(
      'not-due',
    );
    expect(await runDigestIfDue(deps)).toBe('sent');
    expect(await runDigestIfDue(deps)).toBe('not-due');
    expect(sent).toHaveLength(1);
    // Al día siguiente: el 🔴 sigue, marcado ⏰; el 🟡 no.
    const next = digestItems(store, CHAT, '2026-11-12').map((i) => i.id);
    expect(next).toEqual([r]);
    const d = composeDigest(digestItems(store, CHAT, '2026-11-12'), '2026-11-12');
    expect(d.text).toContain('⏰ 1 imprescindible pendiente de otros días');
    expect(d.text).not.toContain(`#${y} `);
    // Visto: ya no se arrastra.
    store.setState(r, 'visto');
    expect(digestItems(store, CHAT, '2026-11-12')).toEqual([]);
  });

  it('lo que nunca salió en un resumen (PC apagado) entra en el siguiente', () => {
    const y = addDone('https://a.com/ideas', 'ideas', 6, '2026-11-10');
    expect(digestItems(store, CHAT, '2026-11-11').map((i) => i.id)).toEqual([y]);
  });

  it('lo que aún se procesaba no se marca como resumido', async () => {
    const { item } = store.add(
      CHAT,
      { kind: 'youtube', url: 'https://youtu.be/BBBBBBBBBBB' },
      NOV11,
      '2026-11-11',
    );
    await sendDigest(
      { store, now: () => NOV11, owner: () => CHAT, send: async () => true },
      CHAT,
      '2026-11-11',
      NOV11,
    );
    expect(store.get(item.id)?.digestedAt).toBeNull();
  });

  it('domingo: detrás, lo mejor de la semana', async () => {
    addDone('https://youtu.be/AAAAAAAAAAA', 'imprescindible', 9);
    const sent: string[] = [];
    const sunday = new Date('2026-11-15T21:00:00Z');
    await runDigestIfDue({
      store,
      now: () => sunday,
      owner: () => CHAT,
      send: async (_c, t) => {
        sent.push(t);
        return true;
      },
      env: {},
    });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatch(/^🏆 Tu semana en la bandeja: 1 cosas guardadas/);
  });

  it('cada cosa del resumen y de su ficha lleva el enlace directo', () => {
    addDone('https://youtu.be/AAAAAAAAAAA', 'imprescindible', 9);
    addDone('https://a.com/ideas', 'ideas', 6);
    addDone('https://a.com/paja', 'paja', 2);
    const { item: pdf } = store.add(
      CHAT,
      { kind: 'pdf', fileId: 'F1', fileName: 'tesis.pdf', title: 'tesis.pdf' },
      NOV11,
      '2026-11-11',
    );
    store.setStatus(pdf.id, 'error', 'el PDF no tiene texto (parece escaneado)');
    const items = digestItems(store, CHAT, '2026-11-11');
    const d = composeDigest(items, '2026-11-11');
    for (const it of items) {
      const links = linkLines(it);
      expect(links.length).toBeGreaterThan(0);
      if (it.url) expect(d.text).toContain(it.url);
      expect(cardText(it)).toContain(links[0] ?? '');
    }
    expect(d.text).toContain('📎 Es el archivo que me mandaste («tesis.pdf»)');
  });
});

describe('bandeja: procesado (red y modelo falsos)', () => {
  const REPLY =
    'TITULO: T\nVEREDICTO: IDEAS\nNOTA: 6\nMOTIVO: m\nIDEAS:\n- a\n- b\n- c\nETIQUETAS: ninguna';
  const base = (over: Partial<ProcesarDeps> = {}): ProcesarDeps => ({
    complete: async () => async () => REPLY,
    fetchRaw: async (url) => {
      throw new Error(`sin red: ${url}`);
    },
    videoText: async () => ({ ok: false, reason: 'YouTube bloqueó la descarga' }),
    ...over,
  });

  it('vídeo con transcripción: duración real y veredicto', async () => {
    const { item } = store.add(
      CHAT,
      { kind: 'youtube', url: 'https://youtu.be/AAAAAAAAAAA' },
      NOV11,
      '2026-11-11',
    );
    const seen: string[] = [];
    const r = await processItem(
      item,
      base({
        videoText: async () => ({
          ok: true,
          meta: { title: 'Buffett 1998', author: 'Canal', durationSeconds: 5400 },
          text: '[00:00] hola',
          source: 'subtitulos',
        }),
        complete: async () => async (_s, user) => {
          seen.push(user);
          return REPLY;
        },
      }),
    );
    expect(r).toMatchObject({
      title: 'Buffett 1998',
      verdict: 'ideas',
      score: 6,
      costLabel: '🎬 1 h 30 min',
    });
    expect(r.extra.basis).toBe('transcripcion');
    expect(seen[0]).toContain('[00:00] hola');
  });

  it('sin transcripción: juzga por la descripción y lo marca con el motivo', async () => {
    const { item } = store.add(
      CHAT,
      { kind: 'youtube', url: 'https://youtu.be/AAAAAAAAAAA' },
      NOV11,
      '2026-11-11',
    );
    const desc = 'Capítulos 00:00 intro 05:00 tesis '.repeat(10);
    const r = await processItem(
      item,
      base({
        fetchRaw: async (url) =>
          url.includes('oembed')
            ? JSON.stringify({ title: 'Firefly', author_name: 'Arkaea' })
            : `"shortDescription":"${desc}","lengthSeconds":"600","viewCount":"5604"`,
      }),
    );
    expect(r.extra.basis).toBe('descripcion');
    expect(r.extra.basisReason).toBe('YouTube bloqueó la descarga');
    expect(r.extra.publicRating).toBe('👁️ 6 mil visualizaciones en YouTube');
    store.saveResult(item.id, r, NOV11);
    expect(cardText(store.get(item.id) as never)).toContain(
      '⚠️ Sin transcripción: juzgado por la descripción (YouTube bloqueó la descarga)',
    );
  });

  it('post de X sin vídeo: el texto por fxtwitter', async () => {
    const { item } = store.add(
      CHAT,
      { kind: 'x', url: 'https://x.com/u/status/123456789' },
      NOV11,
      '2026-11-11',
    );
    const r = await processItem(
      item,
      base({
        fetchRaw: async (url) => {
          expect(url).toBe('https://api.fxtwitter.com/u/status/123456789');
          return JSON.stringify({
            tweet: { text: '$ASTS 6G Summit', author: { screen_name: 'u' } },
          });
        },
        temas: () => ['ASTS'],
      }),
    );
    expect(r.extra).toMatchObject({ author: '@u', source: 'X', basis: 'texto', tags: ['ASTS'] });
  });

  it('Spotify: busca la misma entrega en YouTube y usa su transcripción', async () => {
    const { item } = store.add(
      CHAT,
      { kind: 'enlace', url: 'https://open.spotify.com/episode/2sDBCcGpgbJ0baMzHH8u37' },
      NOV11,
      '2026-11-11',
    );
    const r = await processItem(
      item,
      base({
        fetchRaw: async (url, opts) => {
          if (url.includes('spotify.com')) {
            expect(opts?.userAgent).toBe('facebookexternalhit/1.1');
            return '<meta property="og:title" content="#60: BROOKFIELD a FONDO"/><meta property="og:description" content="+FlowKCash · Episode"/><meta name="music:duration" content="15795"/>';
          }
          if (url.includes('results?search_query'))
            return '"videoRenderer":{"videoId":"uBUULetSEJU","x":1,"title":{"runs":[{"text":"#60: BROOKFIELD a FONDO: historia"}]}';
          throw new Error('no');
        },
        videoText: async (url) =>
          url.includes('uBUULetSEJU')
            ? {
                ok: true,
                meta: { title: 'v', author: 'a', durationSeconds: 100 },
                text: 'texto real',
                source: 'subtitulos',
              }
            : { ok: false, reason: 'no' },
      }),
    );
    expect(r.extra).toMatchObject({
      basis: 'transcripcion',
      altUrl: 'https://www.youtube.com/watch?v=uBUULetSEJU',
    });
    expect(r.costLabel).toBe('🎧 4 h 23 min');
  });

  it('Spotify sin YouTube ni RSS: ficha con «sin transcripción», no se rompe', async () => {
    const { item } = store.add(
      CHAT,
      { kind: 'enlace', url: 'https://open.spotify.com/episode/X1' },
      NOV11,
      '2026-11-11',
    );
    const r = await processItem(
      item,
      base({
        fetchRaw: async (url) => {
          if (url.includes('spotify.com'))
            return '<meta property="og:title" content="Episodio raro"/>';
          throw new Error('no');
        },
      }),
    );
    expect(r.extra.basis).toBe('ficha');
    expect(r.extra.basisReason).toContain('no está en YouTube');
  });

  it('una captura con varias cosas se parte en una por cosa (y no repite lo ya guardado)', async () => {
    const prev = store.add(
      CHAT,
      { kind: 'youtube', url: 'https://youtu.be/OKV4yyLOV2c' },
      NOV11,
      '2026-11-11',
    );
    const { item } = store.add(
      CHAT,
      { kind: 'imagen', fileId: 'P1', mimeType: 'image/jpeg' },
      NOV11,
      '2026-11-11',
    );
    const queue = new BandejaQueue(store, {
      complete: async () => async (system) =>
        system.includes('captura')
          ? 'ENLACE: https://www.youtube.com/watch?v=OKV4yyLOV2c\nVIDEO: How I use LLMs | Andrej Karpathy\nPOST: @AlmaCap | Blacklift thread'
          : REPLY,
      fetchRaw: async () => {
        throw new Error('sin red');
      },
      videoText: async () => ({ ok: false, reason: 'no' }),
      download: async () => Buffer.from('jpg'),
      addChild: (parent, child) => store.add(parent.chatId, child, NOV11, parent.day),
    });
    await queue.enqueue(item.id);
    await queue.idle();
    const img = store.get(item.id);
    expect(img?.state).toBe('descartado');
    expect(img?.error).toMatch(/era una lista: la separé en 2 .*1 ya estaba guardada/);
    const kinds = store.pending(CHAT).map((i) => `${i.kind}:${i.title ?? i.url}`);
    expect(kinds).toEqual([
      `youtube:${prev.item.url}`,
      'youtube:How I use LLMs',
      'texto:Post de @AlmaCap',
    ]);
  });

  it('si la transcripción revienta, se juzga por la descripción (no queda en error)', async () => {
    const { item } = store.add(
      CHAT,
      { kind: 'youtube', url: 'https://youtu.be/tCDY1k1JGqw' },
      NOV11,
      '2026-11-11',
    );
    const r = await processItem(
      item,
      base({
        videoText: async () => {
          throw new SyntaxError(`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`);
        },
        fetchRaw: async (url: string) =>
          url.includes('oembed')
            ? JSON.stringify({ title: 'Vídeo', author_name: 'Canal' })
            : `"attributedDescriptionBodyText":{"content":"${'Una charla larga sobre satélites y espectro. '.repeat(8)}"}`,
      }),
    );
    expect(r.extra.basis).toBe('descripcion');
    expect(r.extra.basisReason).toMatch(/YouTube contestó algo raro/);
  });

  it('un vídeo de captura que ya estaba se descarta antes de gastar modelo', async () => {
    const prev = store.add(
      CHAT,
      { kind: 'youtube', url: 'https://youtu.be/EWvNQjAaOHw' },
      NOV11,
      '2026-11-11',
    );
    const { item } = store.add(
      CHAT,
      { kind: 'youtube', title: 'How I use LLMs', note: 'Andrej Karpathy' },
      NOV11,
      '2026-11-11',
    );
    let llm = 0;
    const queue = new BandejaQueue(
      store,
      base({
        complete: async () => async () => {
          llm++;
          return REPLY;
        },
        fetchRaw: async () =>
          '"videoRenderer":{"videoId":"EWvNQjAaOHw","x":1,"title":{"runs":[{"text":"How I use LLMs"}]}',
      }),
    );
    await queue.enqueue(item.id);
    expect(store.get(item.id)).toMatchObject({
      state: 'descartado',
      error: `repetido de #${prev.item.id}`,
    });
    expect(llm).toBe(0);
  });

  it('un fallo queda en error con su motivo, sin reintentos', async () => {
    const { item } = store.add(
      CHAT,
      { kind: 'youtube', url: 'https://youtu.be/AAAAAAAAAAA' },
      NOV11,
      '2026-11-11',
    );
    let calls = 0;
    const queue = new BandejaQueue(
      store,
      base({
        videoText: async () => {
          calls++;
          return { ok: false, reason: 'el vídeo es privado' };
        },
      }),
    );
    await queue.enqueue(item.id);
    expect(calls).toBe(1);
    expect(store.get(item.id)).toMatchObject({
      status: 'error',
      error: 'no pude sacar el texto del vídeo: el vídeo es privado',
    });
  });

  it('libro: Goodreads + Open Library; el modelo recibe la nota real', async () => {
    const { item } = store.add(
      CHAT,
      { kind: 'libro', title: 'El nombre del viento' },
      NOV11,
      '2026-11-11',
    );
    const seen: string[] = [];
    const r = await processItem(
      item,
      base({
        fetchRaw: async (url) => {
          if (url.includes('goodreads.com/search')) return GR_HTML;
          if (url.includes('search.json'))
            return JSON.stringify({
              docs: [
                {
                  key: '/works/OL1W',
                  title: 'El nombre del viento',
                  author_name: ['Patrick Rothfuss'],
                  number_of_pages_median: 662,
                  ratings_average: 4.4,
                  ratings_count: 210,
                },
              ],
            });
          if (url.endsWith('/works/OL1W.json')) return JSON.stringify({ description: 'Kvothe…' });
          throw new Error('no');
        },
        complete: async () => async (_s, user) => {
          seen.push(user);
          return REPLY;
        },
      }),
    );
    expect(r.extra.goodreads).toMatchObject({ ok: true, rating: 4.52, ratings: 1126819 });
    expect(r.costLabel).toBe('📚 662 págs · ~14 h');
    expect(seen[0]).toContain('Goodreads: 4.52/5 con 1126819 valoraciones');
    expect(r.extra.publicRating).toBe('⭐ Open Library 4,40/5 (210 valoraciones)');
  });

  it('sin modelo: error claro, nunca un veredicto inventado', async () => {
    const { item } = store.add(
      CHAT,
      { kind: 'texto', title: 'idea', note: 'una idea larga' },
      NOV11,
      '2026-11-11',
    );
    await expect(processItem(item, base({ complete: async () => undefined }))).rejects.toThrow(
      'no tengo modelo para juzgarlo ahora mismo',
    );
  });
});

describe('bandeja: /bandeja y botones', () => {
  const deps = () => ({
    store,
    queue: new BandejaQueue(store, {
      complete: async () => undefined,
      fetchRaw: async () => '',
      videoText: async () => ({ ok: false as const, reason: 'no' }),
    }),
    chatId: CHAT,
    now: () => new Date('2026-11-11T21:00:00Z'),
    env: {},
  });

  it('✅ visto, ⏭️ mañana y 🗑️ fuera', async () => {
    const id = addDone('https://a.com/x', 'ideas', 6);
    expect((await bandejaCommand(`visto ${id}`, deps())).text).toMatch(/^✅ #\d+ visto/);
    expect(store.get(id)?.state).toBe('visto');
    await bandejaCommand(`manana ${id}`, deps());
    expect(store.get(id)).toMatchObject({ state: 'pendiente', day: '2026-11-12' });
    await bandejaCommand(`descartar ${id}`, deps());
    expect(store.get(id)?.state).toBe('descartado');
    expect((await bandejaCommand('visto 999', deps())).text).toContain('No tengo la #999');
  });

  it('🧹 quita toda la paja hasta ese día', async () => {
    const p1 = addDone('https://a.com/p1', 'paja', 2);
    const y = addDone('https://a.com/y', 'ideas', 6);
    expect((await bandejaCommand('paja 20261111', deps())).text).toBe(
      '🧹 Quitada la paja: 1 cosa.',
    );
    expect(store.get(p1)?.state).toBe('descartado');
    expect(store.get(y)?.state).toBe('pendiente');
  });

  it('hora y captura se guardan como ajustes', async () => {
    expect((await bandejaCommand('hora 22', deps())).text).toContain('22:00');
    expect((await bandejaCommand('hora mañana', deps())).text).toContain('sale a las 22:00');
    expect(captureOn(store, {})).toBe(true);
    expect(captureOn(store, { PA_BANDEJA_CAPTURA: '0' })).toBe(false);
    await bandejaCommand('captura on', deps());
    expect(captureOn(store, { PA_BANDEJA_CAPTURA: '0' })).toBe(true);
    await bandejaCommand('captura off', deps());
    expect(captureOn(store, {})).toBe(false);
    expect(parseHora('9:05')).toBe('09:05');
    expect(parseHora('25:00')).toBeNull();
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
  });

  it('/bandeja lista lo de hoy y la ficha lleva sus tres botones (y «📖 Al Kindle» si se lee)', async () => {
    const id = addDone('https://a.com/x', 'imprescindible', 9);
    expect((await bandejaCommand('', deps())).text).toContain(`🔴 #${id}`);
    const card = await bandejaCommand(`ver ${id}`, deps());
    expect(card.text).toContain('🔴 Imprescindible: léelo entero · 9/10');
    expect(card.perRow).toBe(3);
    expect(card.buttons?.map((b) => b.label)).toEqual([
      '✅ visto',
      '⏭️ mañana',
      '🗑️ fuera',
      '📖 Al Kindle',
    ]);
  });
});

describe('bandeja: piezas sueltas', () => {
  it('buildKeyboard admite 3 botones por fila', () => {
    const it = { id: 7 } as never;
    const kb = buildKeyboard(
      [...itemButtons(it, true), ...itemButtons({ id: 8 } as never, true)],
      3,
    );
    expect(kb.inline_keyboard.map((row) => row.length)).toEqual([3, 3]);
    expect(buildKeyboard(itemButtons(it)).inline_keyboard.map((row) => row.length)).toEqual([2, 1]);
  });

  it('búsqueda de YouTube, RSS y lista de una captura', () => {
    expect(
      parseYoutubeSearch(
        '"videoRenderer":{"videoId":"uBUULetSEJU","a":{},"title":{"runs":[{"text":"#60: BROOKFIELD \\u0026 co"}]}',
      ),
    ).toEqual([{ id: 'uBUULetSEJU', title: '#60: BROOKFIELD & co' }]);
    expect(titleOverlap('#60: BROOKFIELD a FONDO', '#60: Brookfield a fondo: historia')).toBe(1);
    const rss =
      '<item><title>Otro</title><enclosure url="https://a.com/1.mp3"/></item><item><title><![CDATA[#60: BROOKFIELD a FONDO]]></title><enclosure url="https://a.com/60.mp3" type="audio/mpeg"/></item>';
    expect(enclosureFor(rss, '#60: BROOKFIELD a FONDO')).toBe('https://a.com/60.mp3');
    expect(parseSplit('UNA')).toBeNull();
    expect(parseSplit('ENLACE: https://youtu.be/AAAAAAAAAAA\nVIDEO: X | Y')).toEqual([
      { kind: 'youtube', url: 'https://youtu.be/AAAAAAAAAAA' },
      { kind: 'youtube', title: 'X', note: 'Y' },
    ]);
  });
});

describe('bandeja: notas provisionales y lo visto en capturas', () => {
  it('sin transcripción la nota lleva «~» y la ficha dice «(provisional)»', () => {
    const id = addDone('https://youtu.be/AAAAAAAAAAA', 'imprescindible', 8);
    const it0 = store.get(id);
    if (!it0) throw new Error('no item');
    store.saveResult(
      id,
      {
        ...it0,
        extra: { source: 'YouTube', basis: 'descripcion', basisReason: 'YouTube bloqueó' },
      },
      NOV11,
    );
    const it = store.get(id);
    if (!it) throw new Error('no item');
    expect(scoreLabel(it)).toBe('~8/10');
    expect(cardText(it)).toContain('🔴 Imprescindible: míralo entero · ~8/10 (provisional)');
    expect(cardText(it)).toContain(
      '⚠️ Sin transcripción: juzgado por la descripción (YouTube bloqueó)',
    );
    expect(composeDigest([it], '2026-11-11').text).toContain('~8/10');
    const done = addDone('https://youtu.be/CCCCCCCCCCC', 'ideas', 6);
    expect(scoreLabel(store.get(done) as never)).toBe('6/10');
  });

  it('«Post de @usuario» de una captura no repite el post de X ya guardado por su enlace', () => {
    const x = store.add(
      CHAT,
      { kind: 'x', url: 'https://x.com/trypto_tran/status/2118686002000876028' },
      NOV11,
      '2026-11-11',
    );
    const post = store.add(
      CHAT,
      { kind: 'texto', title: 'Post de @trypto_tran', note: 'Post de X de @trypto_tran: …' },
      NOV11,
      '2026-11-11',
    );
    expect(post.dup).toBe(true);
    expect(post.item.id).toBe(x.item.id);
    expect(
      store.add(CHAT, { kind: 'texto', title: 'Post de @otro', note: 'x' }, NOV11, '2026-11-11')
        .dup,
    ).toBe(false);
  });

  it('un artículo que solo se ve en una captura: «sin abrir», nota provisional', async () => {
    const [cand] = parseSplit('ARTICULO: Tesis de inversión ASTS | PDF') ?? [];
    if (!cand) throw new Error('sin candidato');
    const { item } = store.add(CHAT, cand, NOV11, '2026-11-11');
    const r = await processItem(item, {
      complete: async () => async () => 'VEREDICTO: IDEAS\nNOTA: 6',
      fetchRaw: async () => '',
      videoText: async () => ({ ok: false, reason: 'no' }),
    });
    expect(r.extra.basis).toBe('ficha');
    store.saveResult(item.id, r, NOV11);
    expect(cardText(store.get(item.id) as never)).toContain(
      '⚠️ Sin abrir: juzgado solo por el título',
    );
  });

  it('la bandeja transcribe hasta 3 h por defecto (PA_BANDEJA_MAX_MIN)', () => {
    expect(bandejaMaxMinutes({})).toBe(180);
    expect(bandejaMaxMinutes({ PA_BANDEJA_MAX_MIN: '300' })).toBe(300);
    expect(bandejaMaxMinutes({ PA_BANDEJA_MAX_MIN: '2' })).toBe(180);
  });
});
