import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { uniqueTmpPath } from '../src/fs-tmp.js';
import { AudioRecall } from '../src/media/recall.js';
import { MemorySnapshot } from '../src/memory/snapshot.js';
import { SkillStore } from '../src/skills/store.js';

// El daemon y la CLI (`pa …`) escriben los mismos ficheros. Con un `${f}.tmp` fijo,
// el tmp de otro proceso a medio escribir bloquea (o se cuela en) esta escritura.
// Aquí el «otro proceso» deja ocupado `${f}.tmp` con un directorio: con un tmp
// propio por proceso la escritura sigue funcionando y no deja temporales.
const fresh = (p: string) => mkdtempSync(join(tmpdir(), p));

describe('tmp por proceso en escrituras atómicas', () => {
  it('uniqueTmpPath es distinto en cada llamada y lleva el pid', () => {
    const a = uniqueTmpPath('/x/f.json');
    const b = uniqueTmpPath('/x/f.json');
    expect(a).not.toBe(b);
    expect(a.startsWith(`/x/f.json.${process.pid}.`)).toBe(true);
    expect(a.endsWith('.tmp')).toBe(true);
  });

  it('PERFIL.md se escribe aunque PERFIL.md.tmp esté ocupado por otro proceso', () => {
    const dir = fresh('pa-tmp-snap-');
    mkdirSync(join(dir, 'PERFIL.md.tmp'), { recursive: true });
    const snap = new MemorySnapshot({ dir });
    expect(snap.appendEntry('vive en Valencia').ok).toBe(true);
    expect(readFileSync(join(dir, 'PERFIL.md'), 'utf8')).toContain('vive en Valencia');
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp') && n !== 'PERFIL.md.tmp')).toEqual([]);
  });

  it('una skill se guarda aunque SKILL.md.tmp esté ocupado', () => {
    const dir = fresh('pa-tmp-skill-');
    const store = new SkillStore({ dir });
    const id = store.save({
      name: 'regar plantas',
      description: 'riego',
      category: 'casa',
      whenToUse: 'cuando toque regar',
      steps: ['abrir grifo'],
    });
    mkdirSync(`${store.fileFor(id)}.tmp`, { recursive: true });
    expect(() =>
      store.improve(id, ['abrir grifo', 'cerrar grifo'], 'faltaba cerrar'),
    ).not.toThrow();
    expect(readFileSync(store.fileFor(id), 'utf8')).toContain('cerrar grifo');
  });

  it('el índice de audios se guarda aunque index.json.tmp esté ocupado', () => {
    const dir = fresh('pa-tmp-audio-');
    mkdirSync(join(dir, 'index.json.tmp'), { recursive: true });
    const recall = new AudioRecall({ directory: dir });
    expect(() =>
      recall.record('tg:1', { messageId: '7', fileId: 'f', mimeType: 'audio/ogg' }),
    ).not.toThrow();
    expect(readFileSync(join(dir, 'index.json'), 'utf8')).toContain('tg:1');
    expect(new AudioRecall({ directory: dir }).byMessage('tg:1', '7')).not.toBeNull();
  });
});
