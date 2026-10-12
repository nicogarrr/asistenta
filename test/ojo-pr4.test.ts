import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { UnifiedAgenda } from '../src/agenda/unified.js';
import {
  createDownloadsController,
  fileKind,
  formatDownloads,
  getDownloadsEnabled,
  pendingDownloads,
  recordDownload,
  resolveDownloadsDir,
  STALE_MS,
  safeName,
  setDownloadsEnabled,
} from '../src/ojo-downloads.js';
import { runVigilanteOnce } from '../src/vigilante.js';
import type { FileEvent } from '../src/watch/files.js';

const TZ = 'Europe/Madrid';
const BASE = new Date('2026-10-12T10:00:00+02:00').getTime();
const DIR = join(tmpdir(), 'ojo-dl-fake');
const created = (name: string, bytes = 1000, dir = DIR): FileEvent => ({
  path: join(dir, name),
  kind: 'created',
  at: new Date(BASE).toISOString(),
  bytes,
  extension: '.pdf',
});
const emptyAgenda = (): UnifiedAgenda => ({
  today: [],
  upcoming: [],
  pending: [],
  generatedAt: BASE,
  days: 7,
  counts: { calendar: 0, mail: 0, pending: 0 },
  notes: [],
});
function rig(quiet = false) {
  const db = new DatabaseSync(':memory:');
  const sent: string[] = [];
  let now = BASE;
  return {
    db,
    sent,
    at: (t: number) => {
      now = t;
    },
    run: () =>
      runVigilanteOnce(
        {
          db,
          agenda: async () => emptyAgenda(),
          send: async (t) => {
            sent.push(t);
            return true;
          },
          now: () => now,
          ...(quiet ? { quiet: { startHour: 22, endHour: 8 } } : {}),
        },
        TZ,
      ),
  };
}

describe('carpeta de Descargas', () => {
  const yes = () => true;
  it('Windows: %USERPROFILE%\\Downloads; Linux/mac: ~/Downloads', () => {
    expect(
      resolveDownloadsDir({
        platform: 'win32',
        env: { USERPROFILE: 'C:\\Users\\nico' },
        home: '/h',
        isDir: yes,
      }),
    ).toBe('C:\\Users\\nico\\Downloads');
    expect(
      resolveDownloadsDir({ platform: 'linux', env: {}, home: '/home/nico', isDir: yes }),
    ).toBe(join('/home/nico', 'Downloads'));
    expect(
      resolveDownloadsDir({ platform: 'darwin', env: {}, home: '/Users/nico', isDir: yes }),
    ).toBe(join('/Users/nico', 'Downloads'));
  });
  it('el override gana, y si no existe NO cae a la carpeta del sistema', () => {
    expect(
      resolveDownloadsDir({ override: '/data/dl', platform: 'linux', home: '/h', isDir: yes }),
    ).toMatch(/data[\\/]dl$/);
    expect(
      resolveDownloadsDir({
        override: '/data/dl',
        platform: 'linux',
        home: '/h',
        isDir: (p) => p.includes('Downloads'),
      }),
    ).toBeNull();
    expect(
      resolveDownloadsDir({ platform: 'linux', env: {}, home: '/h', isDir: () => false }),
    ).toBeNull();
  });
});

describe('interruptor: nace apagado', () => {
  it('apagado por defecto y no registra nada', () => {
    const db = new DatabaseSync(':memory:');
    expect(getDownloadsEnabled(db)).toBe(false);
    expect(recordDownload(db, DIR, created('a.pdf'), BASE)).toBe(false);
    expect(pendingDownloads(db, BASE)).toEqual([]);
  });
  it('apagar descarta lo pendiente: no reaparece al volver a encender', () => {
    const db = new DatabaseSync(':memory:');
    setDownloadsEnabled(db, true);
    expect(recordDownload(db, DIR, created('a.pdf'), BASE)).toBe(true);
    setDownloadsEnabled(db, false);
    setDownloadsEnabled(db, true);
    expect(pendingDownloads(db, BASE)).toEqual([]);
  });
});

describe('qué se registra', () => {
  const on = () => {
    const db = new DatabaseSync(':memory:');
    setDownloadsEnabled(db, true);
    return db;
  };
  it('solo archivos nuevos y sueltos de la carpeta; fuera ruido, subcarpetas y vacíos', () => {
    const db = on();
    expect(recordDownload(db, DIR, created('factura.pdf'), BASE)).toBe(true);
    expect(recordDownload(db, DIR, created('desktop.ini'), BASE)).toBe(false);
    expect(recordDownload(db, DIR, created('.hidden'), BASE)).toBe(false);
    expect(recordDownload(db, DIR, created('x.pdf', 10, join(DIR, 'sub')), BASE)).toBe(false);
    expect(recordDownload(db, DIR, created('vacio.pdf', 0), BASE)).toBe(false);
    expect(recordDownload(db, DIR, { ...created('c.pdf'), kind: 'changed' }, BASE)).toBe(false);
    expect(recordDownload(db, DIR, { ...created('r.pdf'), kind: 'removed' }, BASE)).toBe(false);
    expect(pendingDownloads(db, BASE).map((d) => d.name)).toEqual(['factura.pdf']);
  });
  it('el mismo archivo no se registra dos veces', () => {
    const db = on();
    expect(recordDownload(db, DIR, created('a.pdf'), BASE)).toBe(true);
    expect(recordDownload(db, DIR, created('a.pdf'), BASE + 1)).toBe(false);
  });
  it('tope de pendientes y caducidad de las viejas', () => {
    const db = on();
    for (let i = 0; i < 60; i++) recordDownload(db, DIR, created(`f${i}.pdf`, 100 + i), BASE + i);
    expect(pendingDownloads(db, BASE + 100)).toHaveLength(50);
    expect(pendingDownloads(db, BASE + STALE_MS + 1000)).toHaveLength(0);
  });
});

describe('texto del aviso', () => {
  it('tipo por extensión, nombre saneado, sin rutas, y tope con "y N más"', () => {
    expect(fileKind('.PDF')).toBe('PDF');
    expect(fileKind('.exe')).toBe('instalador o programa');
    expect(fileKind('.zzz')).toBe('archivo');
    expect(safeName('a\nb\u202etxt.exe')).toBe('a b txt.exe');
    // por codepoint: C0, DEL, C1, bidi, aislantes, ALM, ancho cero, BOM
    const bad: number[] = [];
    for (let c = 0; c <= 0x1f; c++) bad.push(c);
    for (let c = 0x7f; c <= 0x9f; c++) bad.push(c);
    for (const c of [0x61c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0xfeff])
      bad.push(c);
    for (let c = 0x202a; c <= 0x202e; c++) bad.push(c);
    for (let c = 0x2060; c <= 0x206f; c++) bad.push(c);
    for (const c of bad) expect(safeName(`a${String.fromCodePoint(c)}b.pdf`)).toBe('a b.pdf');
    expect(safeName('x'.repeat(100)).length).toBe(60);
    const items = Array.from({ length: 7 }, (_, i) => ({
      key: `k${i}`,
      name: `doc${i}.pdf`,
      ext: '.pdf',
      bytes: 2048,
      at: BASE,
    }));
    const text = formatDownloads(items);
    expect(text).toContain('7 archivos');
    expect(text).toContain('doc0.pdf (PDF, 2 KB)');
    expect(text).toContain('y 2 más');
    expect(text).not.toContain(DIR);
    expect(text).toContain('no he abierto nada');
  });
});

describe('en el barrido del vigilante', () => {
  it('apagado no avisa; encendido manda un digest una sola vez', async () => {
    const r = rig();
    await r.run();
    recordDownload(r.db, DIR, created('a.pdf'), BASE);
    await r.run();
    expect(r.sent).toHaveLength(0);
    setDownloadsEnabled(r.db, true);
    recordDownload(r.db, DIR, created('contrato.pdf'), BASE);
    await r.run();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toContain('contrato.pdf');
    await r.run();
    expect(r.sent).toHaveLength(1);
  });
  it('en horas de silencio espera y sale al terminar', async () => {
    const r = rig(true);
    setDownloadsEnabled(r.db, true);
    const night = new Date('2026-10-12T23:30:00+02:00').getTime();
    r.at(night);
    recordDownload(r.db, DIR, created('noche.pdf'), night);
    await r.run();
    expect(r.sent).toHaveLength(0);
    r.at(new Date('2026-10-13T08:30:00+02:00').getTime());
    await r.run();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toContain('noche.pdf');
  });
});

describe('vigilante real de carpeta', () => {
  it('detecta un archivo nuevo, ignora lo previo y las subcarpetas, y para al apagar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ojo-dl-'));
    try {
      writeFileSync(join(dir, 'previo.pdf'), 'x'.repeat(50));
      const db = new DatabaseSync(':memory:');
      const ctl = createDownloadsController({ db, getOverride: async () => dir });
      expect(await ctl.apply()).toMatchObject({ running: false }); // apagado
      setDownloadsEnabled(db, true);
      expect(await ctl.apply()).toMatchObject({ running: true });
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'sub', 'dentro.pdf'), 'x'.repeat(50));
      writeFileSync(join(dir, 'nuevo.pdf'), 'x'.repeat(50));
      let names: string[] = [];
      for (let i = 0; i < 40 && names.length === 0; i++) {
        await new Promise((res) => setTimeout(res, 150));
        names = pendingDownloads(db, Date.now()).map((d) => d.name);
      }
      expect(names).toEqual(['nuevo.pdf']);
      setDownloadsEnabled(db, false);
      expect(await ctl.apply()).toMatchObject({ running: false });
      writeFileSync(join(dir, 'tarde.pdf'), 'x'.repeat(50));
      await new Promise((res) => setTimeout(res, 1500));
      expect(pendingDownloads(db, Date.now())).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('R1: ciclo de vida del vigilante de carpeta', () => {
  const gated = () => {
    let release: (v: string) => void = () => {};
    const p = new Promise<string>((res) => {
      release = res;
    });
    return { p, release };
  };
  it('stop durante el arranque: el arranque viejo no crea nada después', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ojo-dl-'));
    try {
      const db = new DatabaseSync(':memory:');
      setDownloadsEnabled(db, true);
      const g = gated();
      const ctl = createDownloadsController({ db, getOverride: () => g.p });
      const pending = ctl.apply();
      ctl.stop();
      g.release(dir);
      expect(await pending).toMatchObject({ running: false });
      expect(await ctl.apply()).toMatchObject({ running: false }); // definitivo
      writeFileSync(join(dir, 'tarde.pdf'), 'x'.repeat(50));
      await new Promise((res) => setTimeout(res, 1500));
      expect(pendingDownloads(db, Date.now())).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
  it('off durante el arranque: no arranca', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ojo-dl-'));
    try {
      const db = new DatabaseSync(':memory:');
      setDownloadsEnabled(db, true);
      const g = gated();
      const ctl = createDownloadsController({ db, getOverride: () => g.p });
      const pending = ctl.apply();
      setDownloadsEnabled(db, false);
      g.release(dir);
      expect(await pending).toMatchObject({ running: false });
      ctl.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('estado real: carpeta inexistente o que muere se dice, y se reintenta', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ojo-dl-'));
    try {
      const db = new DatabaseSync(':memory:');
      setDownloadsEnabled(db, true);
      let target = join(dir, 'no-existe');
      const ctl = createDownloadsController({ db, getOverride: async () => target });
      expect(await ctl.apply()).toMatchObject({ running: false });
      target = dir;
      expect(await ctl.apply()).toMatchObject({ running: true });
      ctl.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('R1: pérdidas por saturación se dicen', () => {
  it('el tope de pendientes y el ritmo del vigilante aparecen en el digest, una vez', async () => {
    const r = rig();
    setDownloadsEnabled(r.db, true);
    for (let i = 0; i < 53; i++) recordDownload(r.db, DIR, created(`f${i}.pdf`, 100 + i), BASE + i);
    let suppressed = 4;
    const sent: string[] = [];
    const run = () =>
      runVigilanteOnce(
        {
          db: r.db,
          agenda: async () => emptyAgenda(),
          send: async (t) => {
            sent.push(t);
            return true;
          },
          now: () => BASE + 100,
          downloadsSuppressed: () => suppressed,
        },
        TZ,
      );
    await run();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('7 más que no pude seguir'); // 3 por tope + 4 por ritmo
    await run();
    expect(sent).toHaveLength(1);
    suppressed = 6;
    await run();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('2 no las pude seguir');
  });
});
describe('R2: salud acotada y contadores idempotentes', () => {
  it('una salud que no resuelve no bloquea el barrido ni los avisos', async () => {
    const r = rig();
    setDownloadsEnabled(r.db, true);
    recordDownload(r.db, DIR, created('a.pdf'), BASE);
    const t0 = Date.now();
    await runVigilanteOnce(
      {
        db: r.db,
        agenda: async () => emptyAgenda(),
        send: async (t) => {
          r.sent.push(t);
          return true;
        },
        now: () => BASE + 100,
        agendaTimeoutMs: 50,
        downloadsHealth: () => new Promise(() => {}),
      },
      TZ,
    );
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toContain('a.pdf');
  });
  it('un getOverride colgado no atasca el controller y stop no espera', async () => {
    const db = new DatabaseSync(':memory:');
    setDownloadsEnabled(db, true);
    const ctl = createDownloadsController({
      db,
      getOverride: () => new Promise(() => {}),
      overrideTimeoutMs: 50,
    });
    const st = await ctl.apply();
    expect(st.running).toBe(false);
    expect(st.reason).toContain('bóveda');
    const t0 = Date.now();
    ctl.stop();
    expect(Date.now() - t0).toBeLessThan(100);
  });
  it('repetir "on" no borra pérdidas pendientes; off -> on sí empieza sesión nueva', async () => {
    const r = rig();
    setDownloadsEnabled(r.db, true);
    for (let i = 0; i < 60; i++) recordDownload(r.db, DIR, created(`f${i}.pdf`, 100 + i), BASE + i);
    setDownloadsEnabled(r.db, true); // repetido
    await r.run();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toContain('10 más que no pude seguir');
    setDownloadsEnabled(r.db, false);
    setDownloadsEnabled(r.db, true);
    await r.run();
    expect(r.sent).toHaveLength(1); // nada viejo resucita
  });
});
