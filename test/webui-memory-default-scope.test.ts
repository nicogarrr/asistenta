import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore, panelMemoryEntries } from '../src/memory.js';

const dirs: string[] = [];
function store(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), 'pa-panel-mem-'));
  dirs.push(dir);
  return new MemoryStore(dir);
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('pestaña Memoria del panel', () => {
  it('sin ámbito enseña lo que el dueño contó por Telegram, no un «local» vacío', () => {
    const m = store();
    m.remember('telegram:dm:42#main', 'Mi tren sale de Atocha');
    const texts = panelMemoryEntries(m, undefined, 42).map((e) => e.text);
    expect(texts).toEqual(['Mi tren sale de Atocha']);
    expect(panelMemoryEntries(m, '  ', 42).map((e) => e.text)).toEqual(['Mi tren sale de Atocha']);
  });

  it('con un hilo elegido lee como /memoria: principal más el hilo, nunca otro chat', () => {
    const m = store();
    m.remember('telegram:dm:42#main', 'Soy alérgico a las nueces');
    m.remember('telegram:dm:42#viaje', 'Hotel en Lisboa reservado');
    m.remember('telegram:group:7#main', 'Cena del grupo el viernes');
    const texts = panelMemoryEntries(m, 'telegram:dm:42#viaje', 42).map((e) => e.text);
    expect(texts).toContain('Soy alérgico a las nueces');
    expect(texts).toContain('Hotel en Lisboa reservado');
    expect(texts).not.toContain('Cena del grupo el viernes');
  });

  it('sin dueño configurado sigue leyendo el ámbito local', () => {
    const m = store();
    m.remember('local', 'nota de la CLI');
    expect(panelMemoryEntries(m, undefined, undefined).map((e) => e.text)).toEqual([
      'nota de la CLI',
    ]);
  });
});
