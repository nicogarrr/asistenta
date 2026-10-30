import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { append, clear, list } from '../src/memory/review.js';

let dir: string;
let queuePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-review-corrupt-'));
  queuePath = join(dir, 'contradicciones.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function backups(): string[] {
  return readdirSync(dir).filter((name) => name.startsWith('contradicciones.json.corrupt-'));
}

describe('cola de contradicciones corrupta', () => {
  it('append aparta la cola rota antes de escribir y conserva su contenido', () => {
    const broken = '[{"id":"rv-1","a":"vive en Madrid","b":"no vive en Madrid"},';
    writeFileSync(queuePath, broken, 'utf8');
    const created = append(queuePath, { a: 'come carne', b: 'nunca come carne' });
    expect(list(queuePath).map((item) => item.id)).toEqual([created.id]);
    const saved = backups();
    expect(saved).toHaveLength(1);
    expect(readFileSync(join(dir, saved[0] as string), 'utf8')).toBe(broken);
  });

  it('clear tampoco destruye una cola que no es una lista', () => {
    writeFileSync(queuePath, '{"a":"vive en Madrid"}', 'utf8');
    expect(clear(queuePath)).toBe(0);
    expect(backups()).toHaveLength(1);
    expect(list(queuePath)).toEqual([]);
  });

  it('una cola sana o vacia no deja copias', () => {
    append(queuePath, { a: 'vive en Madrid', b: 'no vive en Madrid' });
    writeFileSync(join(dir, 'vacia.json'), '', 'utf8');
    append(join(dir, 'vacia.json'), { a: 'bebe cafe', b: 'no bebe cafe' });
    clear(queuePath);
    expect(readdirSync(dir).filter((name) => name.includes('.corrupt-'))).toEqual([]);
  });
});
