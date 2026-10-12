import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { UnifiedAgenda } from '../src/agenda/unified.js';
import {
  findScreenFindings,
  formatScreen,
  getScreenEnabled,
  isExcludedWindow,
  pendingScreen,
  recordScreenFindings,
  redact,
  SCREEN_DEDUPE_MS,
  SCREEN_STALE_MS,
  scanScreenOnce,
  setScreenEnabled,
  type WindowLite,
} from '../src/ojo-screen.js';
import { runVigilanteOnce } from '../src/vigilante.js';

const TZ = 'Europe/Madrid';
const BASE = new Date('2026-10-12T10:00:00+02:00').getTime();
const emptyAgenda = (): UnifiedAgenda => ({
  today: [],
  upcoming: [],
  pending: [],
  generatedAt: BASE,
  days: 7,
  counts: { calendar: 0, mail: 0, pending: 0 },
  notes: [],
});
const dump = (db: DatabaseSync): string =>
  JSON.stringify(db.prepare('SELECT * FROM vigilante_screen').all());
const okWin: WindowLite[] = [{ title: 'Documento - Word', process: 'WINWORD' }];

function scanRig(opts: {
  lines?: string[];
  windows?: () => Promise<WindowLite[]>;
  ocr?: (p: string) => Promise<string[]>;
  capture?: () => Promise<{ path: string; cleanup: () => void }>;
}) {
  const db = new DatabaseSync(':memory:');
  setScreenEnabled(db, true);
  const cleaned: string[] = [];
  return {
    db,
    cleaned,
    run: () =>
      scanScreenOnce({
        db,
        interactive: async () => true,
        windows: opts.windows ?? (async () => okWin),
        capture:
          opts.capture ??
          (async () => ({ path: '/tmp/x.jpg', cleanup: () => void cleaned.push('x') })),
        ocr: opts.ocr ?? (async () => opts.lines ?? []),
        now: () => BASE,
        ocrTimeoutMs: 100,
      }),
  };
}

describe('interruptor: nace apagado', () => {
  it('apagado por defecto; off descarta lo pendiente; on repetido no rompe nada', () => {
    const db = new DatabaseSync(':memory:');
    expect(getScreenEnabled(db)).toBe(false);
    setScreenEnabled(db, true);
    setScreenEnabled(db, true);
    recordScreenFindings(db, findScreenFindings(['Factura vence 15/11/2026']), BASE);
    expect(pendingScreen(db, BASE)).toHaveLength(1);
    setScreenEnabled(db, true);
    expect(pendingScreen(db, BASE)).toHaveLength(1);
    setScreenEnabled(db, false);
    expect(pendingScreen(db, BASE)).toEqual([]);
    setScreenEnabled(db, true);
    expect(pendingScreen(db, BASE)).toEqual([]); // no resucita
  });
  it('apagado no registra nada', () => {
    const db = new DatabaseSync(':memory:');
    expect(recordScreenFindings(db, findScreenFindings(['Factura vence 15/11/2026']), BASE)).toBe(
      0,
    );
  });
});

describe('lista de exclusión', () => {
  it.each([
    ['BBVA - Posición global - Google Chrome', 'chrome'],
    ['Santander', 'msedge'],
    ['Mi caja fuerte', 'Bitwarden'],
    ['Entradas', 'KeePassXC'],
    ['Nueva pestaña de incógnito - Chrome', 'chrome'],
    ['Navegación InPrivate', 'msedge'],
    ['Historia clínica - Sanitas', 'chrome'],
    ['Mis contraseñas', 'chrome'],
    ['Resultados analítica', 'chrome'],
    ['Ledger Live', 'ledger'],
  ])('excluye %s', (title, process) => {
    expect(isExcludedWindow({ title, process })).toBe(true);
  });
  it('una ventana normal no se excluye', () => {
    expect(isExcludedWindow({ title: 'Documento - Word', process: 'WINWORD' })).toBe(false);
  });
});

describe('redacción estricta', () => {
  it('oculta IBAN, tarjeta, email, teléfono, DNI, token, contraseña y URL', () => {
    const raw =
      'IBAN ES91 2100 0418 4502 0005 1332 tarjeta 4111 1111 1111 1111 mail juan.perez@gmail.com tel 612 345 678 DNI 12345678Z token sk_live_AbCdEf1234567890XyZ https://x.com/r?t=abc';
    const r = redact(raw);
    for (const leak of [
      'ES91',
      '2100 0418',
      '4111',
      'juan.perez',
      '612 345',
      '12345678',
      'AbCdEf',
      'x.com',
    ])
      expect(r).not.toContain(leak);
    expect(r).toContain('[oculto]');
  });
  it('contraseña: se oculta lo que sigue', () => {
    expect(redact('Contraseña: hunter2 y más')).toBe('Contraseña [oculto]');
  });
  it('una fecha no se oculta', () => {
    expect(redact('vence 15/11/2026')).toBe('vence 15/11/2026');
  });
  it('caracteres de control y bidi fuera', () => {
    expect(redact('a\u202eb\u0085c\u2066d')).toBe('a b c d');
  });
});

describe('hallazgos: solo prueba positiva', () => {
  it('contexto + fecha, o contexto + importe, en la misma línea', () => {
    const f = findScreenFindings([
      'Su factura vence el 15 de noviembre de 2026',
      'Total a pagar: 1.234,50 €',
      'Recibo 45 euros',
    ]);
    expect(f.map((x) => x.snippet)).toEqual([
      'Su factura vence el 15 de noviembre de 2026',
      'Total a pagar: 1.234,50 €',
      'Recibo 45 euros',
    ]);
  });
  it('solo fecha, solo contexto, o importe suelto: nada', () => {
    expect(
      findScreenFindings(['Reunión 15/11/2026', 'Su factura está lista', '12,50 €', 'hola 1234']),
    ).toEqual([]);
  });
  it('el hallazgo lleva datos sensibles redactados y el texto bruto no queda en SQLite', () => {
    const db = new DatabaseSync(':memory:');
    setScreenEnabled(db, true);
    recordScreenFindings(
      db,
      findScreenFindings(['Pago factura 45,30 € a ES9121000418450200051332 antes del 15/11/2026']),
      BASE,
    );
    expect(dump(db)).not.toContain('ES9121');
    expect(dump(db)).toContain('45,30');
    expect(dump(db)).toContain('[oculto]');
  });
  it('mismo hallazgo no se repite en 7 días; después sí', () => {
    const db = new DatabaseSync(':memory:');
    setScreenEnabled(db, true);
    const f = findScreenFindings(['Factura vence 15/11/2026']);
    expect(recordScreenFindings(db, f, BASE)).toBe(1);
    expect(recordScreenFindings(db, f, BASE + 1000)).toBe(0);
    expect(recordScreenFindings(db, f, BASE + SCREEN_DEDUPE_MS + 1)).toBe(1);
  });
  it('tope de pendientes y caducidad de 12 h', () => {
    const db = new DatabaseSync(':memory:');
    setScreenEnabled(db, true);
    const many = Array.from(
      { length: 30 },
      (_, i) => `Factura ${i + 1}/12/2026 importe ${i + 100},00 €`,
    );
    recordScreenFindings(db, findScreenFindings(many), BASE);
    expect(pendingScreen(db, BASE)).toHaveLength(20);
    expect(pendingScreen(db, BASE + SCREEN_STALE_MS + 1)).toEqual([]);
  });
  it('el aviso lista máximo 5 con "y N más", y lo dice honesto', () => {
    const items = Array.from({ length: 7 }, (_, i) => ({
      key: String(i),
      snippet: `Factura ${i + 1}/12/2026`,
      at: BASE,
    }));
    const t = formatScreen(items);
    expect(t).toContain('lectura OCR, puede fallar');
    expect(t).toContain('no guardo la captura');
    expect(t).toContain('• y 2 más');
    expect(t.split('\n').filter((l) => l.startsWith('• Factura'))).toHaveLength(5);
  });
});

describe('escaneo', () => {
  it('captura, lee, guarda solo el hallazgo redactado y borra la imagen', async () => {
    const r = scanRig({ lines: ['Hola Nico, secreto de familia', 'Factura vence 15/11/2026'] });
    expect(await r.run()).toEqual({ ok: true, found: 1 });
    expect(r.cleaned).toEqual(['x']);
    expect(dump(r.db)).not.toContain('secreto de familia');
  });
  it('la imagen se borra aunque el OCR falle o se cuelgue', async () => {
    const a = scanRig({ ocr: async () => Promise.reject(new Error('boom')) });
    expect(await a.run()).toMatchObject({ ok: false });
    expect(a.cleaned).toEqual(['x']);
    const b = scanRig({ ocr: () => new Promise(() => {}) });
    expect(await b.run()).toMatchObject({ ok: false });
    expect(b.cleaned).toEqual(['x']);
  });
  it('captura colgada: vuelve con error y no deja nada', async () => {
    const r = scanRig({ capture: () => new Promise(() => {}) });
    expect(await r.run()).toMatchObject({ ok: false });
    expect(pendingScreen(r.db, BASE)).toEqual([]);
  });
  it('ventana excluida antes: ni captura', async () => {
    let captured = 0;
    const r = scanRig({
      windows: async () => [...okWin, { title: 'BBVA', process: 'chrome' }],
      capture: async () => {
        captured++;
        return { path: 'p', cleanup: () => {} };
      },
    });
    expect(await r.run()).toMatchObject({ ok: false });
    expect(captured).toBe(0);
  });
  it('ventana excluida que aparece tras capturar: se tira y se borra', async () => {
    let n = 0;
    const r = scanRig({
      lines: ['Factura vence 15/11/2026'],
      windows: async () =>
        ++n === 1 ? okWin : [...okWin, { title: 'Bitwarden', process: 'Bitwarden' }],
    });
    expect(await r.run()).toMatchObject({ ok: false });
    expect(r.cleaned).toEqual(['x']);
    expect(pendingScreen(r.db, BASE)).toEqual([]);
  });
  it('falla cerrado: lista de ventanas vacía o que falla', async () => {
    expect(await scanRig({ windows: async () => [] }).run()).toMatchObject({ ok: false });
    expect(await scanRig({ windows: () => Promise.reject(new Error('x')) }).run()).toMatchObject({
      ok: false,
    });
  });
  it('apagar durante el OCR: no se guarda nada', async () => {
    const r = scanRig({
      ocr: async () => {
        setScreenEnabled(r.db, false);
        return ['Factura vence 15/11/2026'];
      },
    });
    expect(await r.run()).toMatchObject({ ok: false, reason: 'apagado' });
    setScreenEnabled(r.db, true);
    expect(pendingScreen(r.db, BASE)).toEqual([]);
  });
});

describe('en el barrido del vigilante', () => {
  function sweep(db: DatabaseSync, extra: Record<string, unknown> = {}, quiet = false) {
    const sent: string[] = [];
    return {
      sent,
      run: () =>
        runVigilanteOnce(
          {
            db,
            agenda: async () => emptyAgenda(),
            send: async (t: string) => {
              sent.push(t);
              return true;
            },
            now: () => BASE,
            ...(quiet ? { quiet: { startHour: 22, endHour: 8 } } : {}),
            ...extra,
          } as never,
          TZ,
        ),
    };
  }
  const scanWith = (db: DatabaseSync, lines: string[]) => () =>
    scanScreenOnce({
      db,
      interactive: async () => true,
      windows: async () => okWin,
      capture: async () => ({ path: 'p', cleanup: () => {} }),
      ocr: async () => lines,
      now: () => BASE,
    });

  it('apagado no mira ni avisa; encendido avisa una sola vez con el contenido', async () => {
    const db = new DatabaseSync(':memory:');
    let calls = 0;
    const s = sweep(db, {
      screenScan: () => {
        calls++;
        return scanWith(db, ['Factura vence 15/11/2026 IBAN ES9121000418450200051332'])();
      },
    });
    await s.run();
    expect(calls).toBe(0);
    expect(s.sent).toEqual([]);
    setScreenEnabled(db, true);
    await s.run();
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toContain('En tu pantalla vi');
    expect(s.sent[0]).toContain('Factura vence 15/11/2026');
    expect(s.sent[0]).not.toContain('ES9121');
    await s.run();
    expect(s.sent).toHaveLength(1);
  });
  it('en horas de silencio no mira ni avisa', async () => {
    const db = new DatabaseSync(':memory:');
    setScreenEnabled(db, true);
    let calls = 0;
    const night = new Date('2026-10-12T23:30:00+02:00').getTime();
    const sent: string[] = [];
    await runVigilanteOnce(
      {
        db,
        agenda: async () => emptyAgenda(),
        send: async (t: string) => {
          sent.push(t);
          return true;
        },
        now: () => night,
        quiet: { startHour: 22, endHour: 8 },
        screenScan: async () => {
          calls++;
        },
      } as never,
      TZ,
    );
    expect(calls).toBe(0);
    expect(sent).toEqual([]);
  });
  it('una lectura colgada no bloquea el barrido ni los demás avisos', async () => {
    const db = new DatabaseSync(':memory:');
    setScreenEnabled(db, true);
    recordScreenFindings(db, findScreenFindings(['Factura vence 15/11/2026']), BASE);
    const t0 = Date.now();
    const s = sweep(db, { agendaTimeoutMs: 50, screenScan: () => new Promise(() => {}) });
    await s.run();
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toContain('Factura vence 15/11/2026');
  });
});
