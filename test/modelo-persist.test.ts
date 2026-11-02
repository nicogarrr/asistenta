import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { formatModelos, ModelChoiceStore } from '../src/model-choice.js';
import { STATE_ENTRIES } from '../src/state-files.js';

const dir = mkdtempSync(join(tmpdir(), 'pa-modelos-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('/modelo: la elección sobrevive a un reinicio', () => {
  it('guarda por conversación y otra instancia (otro arranque) la lee', () => {
    const file = join(dir, 'a', 'modelos.json');
    new ModelChoiceStore(file).set('telegram:dm:1#main', 'alt-model');
    const again = new ModelChoiceStore(file);
    expect(again.get('telegram:dm:1#main')).toBe('alt-model');
    expect(again.get('telegram:dm:1#otro')).toBeUndefined();
  });

  it('«normal» borra la elección y no toca las demás conversaciones', () => {
    const file = join(dir, 'b.json');
    const s = new ModelChoiceStore(file);
    s.set('x#main', 'm2');
    s.set('y#main', 'm3');
    s.set('x#main', undefined);
    expect(s.get('x#main')).toBeUndefined();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'y#main': 'm3' });
  });

  it('un fichero roto o raro cuenta como vacío y no rompe el arranque', () => {
    const file = join(dir, 'c.json');
    writeFileSync(file, '{no es json');
    expect(new ModelChoiceStore(file).get('x#main')).toBeUndefined();
    writeFileSync(file, JSON.stringify({ 'x#main': 5, 'y#main': 'ok' }));
    expect(new ModelChoiceStore(file).get('x#main')).toBeUndefined();
    expect(new ModelChoiceStore(file).get('y#main')).toBe('ok');
  });

  it('un fichero corrupto se aparta con su contenido y un set posterior no lo pisa', () => {
    const file = join(dir, 'corrupto.json');
    writeFileSync(file, '{no es json');
    expect(new ModelChoiceStore(file).get('x#main')).toBeUndefined();
    expect(existsSync(file)).toBe(false);
    const aside = readdirSync(dirname(file)).filter((f) => f.startsWith('corrupto.json.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dirname(file), aside[0] as string), 'utf8')).toBe('{no es json');
    // Y el siguiente `set` escribe un fichero nuevo sin tocar la copia apartada.
    new ModelChoiceStore(file).set('x#main', 'alt-model');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'x#main': 'alt-model' });
    expect(readFileSync(join(dirname(file), aside[0] as string), 'utf8')).toBe('{no es json');
  });

  it('está en el registro de estado (entra en la copia) y la lista lo dice', () => {
    expect(STATE_ENTRIES.find((e) => e.name === 'modelos.json')?.backup).toBe('file');
    expect(formatModelos(['a', 'b'], 'a')).toContain('aunque el asistente reinicie');
  });
});
