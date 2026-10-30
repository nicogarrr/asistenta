import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stateEntry } from '../src/state-files.js';
import { FIRED_BUTTON_MS, FiredReminders } from '../src/tools/reminder.js';
import { COMPARE_WATCH_MS, CompareWatchLinks } from '../src/watch/compare.js';

/**
 * Los botones de un toque (avisos «✅ Hecho»/«⏰ +1h»/«🌅 Mañana 9:00» y «👀 Vigilar» de
 * /compara) sobreviven a un reinicio del daemon (p. ej. tras actualizarse solo): sus ids
 * cortos se guardan en <estado>/botones/. Siguen valiendo una vez, 24 h y mismo chat.
 */
const dir = () => mkdtempSync(join(tmpdir(), 'pa-botones-'));
const same = (chat: string) => (scope: string) => scope === chat;

describe('botones de un toque guardados en disco', () => {
  it('un «✅ Hecho» de antes de reiniciar sigue sirviendo después', () => {
    const f = join(dir(), 'botones', 'recordatorios.json');
    const id = new FiredReminders(() => 1000, 200, f).remember('telegram:dm:1#main', 'pastilla');
    const after = new FiredReminders(() => 2000, 200, f);
    expect(after.take(id, same('telegram:dm:1#main'))).toEqual({
      scope: 'telegram:dm:1#main',
      text: 'pastilla',
    });
  });

  it('vale una vez también entre reinicios', () => {
    const f = join(dir(), 'r.json');
    const id = new FiredReminders(() => 1000, 200, f).remember('s', 'x');
    expect(new FiredReminders(() => 1000, 200, f).take(id, same('s'))).toBeDefined();
    expect(new FiredReminders(() => 1000, 200, f).take(id, same('s'))).toBeUndefined();
  });

  it('tras reiniciar, otro chat no puede usarlo y lo caducado no se carga', () => {
    const f = join(dir(), 'r.json');
    const id = new FiredReminders(() => 0, 200, f).remember('s', 'x');
    expect(new FiredReminders(() => 0, 200, f).take(id, same('otro'))).toBeUndefined();
    expect(
      new FiredReminders(() => FIRED_BUTTON_MS + 1, 200, f).take(id, same('s')),
    ).toBeUndefined();
  });

  it('«👀 Vigilar» de /compara sobrevive a un reinicio (mismo chat, una vez, 24 h)', () => {
    const f = join(dir(), 'botones', 'compara.json');
    const id = new CompareWatchLinks(() => 0, 200, f).remember('42', 'https://tienda.es/p/1');
    expect(new CompareWatchLinks(() => 5, 200, f).take(id, '7')).toBeUndefined();
    expect(new CompareWatchLinks(() => 5, 200, f).take(id, '42')).toBe('https://tienda.es/p/1');
    expect(new CompareWatchLinks(() => 5, 200, f).take(id, '42')).toBeUndefined();
    const id2 = new CompareWatchLinks(() => 0, 200, f).remember('42', 'https://tienda.es/p/2');
    expect(new CompareWatchLinks(() => COMPARE_WATCH_MS + 1, 200, f).take(id2, '42')).toBe(
      undefined,
    );
  });

  it('el fichero es privado (0600) y no guarda nada caducado', () => {
    const d = dir();
    const f = join(d, 'r.json');
    let t = 0;
    const fired = new FiredReminders(() => t, 200, f);
    fired.remember('s', 'viejo');
    t = FIRED_BUTTON_MS + 10;
    fired.remember('s', 'nuevo');
    if (process.platform !== 'win32') expect(statSync(f).mode & 0o777).toBe(0o600);
    const saved = Object.values(JSON.parse(readFileSync(f, 'utf8'))) as Array<{
      v: { text: string };
    }>;
    expect(saved.map((e) => e.v.text)).toEqual(['nuevo']);
  });

  it('un fichero corrupto se aparta y los botones siguen funcionando', () => {
    const d = dir();
    const f = join(d, 'r.json');
    writeFileSync(f, '{roto');
    const fired = new FiredReminders(() => 0, 200, f);
    const id = fired.remember('s', 'x');
    expect(readdirSync(d).some((n) => n.startsWith('r.json.corrupt-'))).toBe(true);
    expect(new FiredReminders(() => 0, 200, f).take(id, same('s'))?.text).toBe('x');
  });

  it('el daemon los guarda en <estado>/botones, registrado con poda', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toContain("join(paths.state, 'botones', 'recordatorios.json')");
    expect(cli).toContain("join(paths.state, 'botones', 'compara.json')");
    const e = stateEntry('botones');
    expect(e?.prune).toBeDefined();
  });
});
