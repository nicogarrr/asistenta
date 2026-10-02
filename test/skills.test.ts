/**
 * Skills (procedural memory): the store, the auto-creation heuristics and the
 * tool that exposes both. Everything runs against a temp dir, because a skill
 * store that writes outside its dir is a bug worth failing over.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decideToSave, extractToolCalls } from '../src/skills/autocreate.js';
import { SkillStore } from '../src/skills/store.js';
import type { Skill, SkillDraft } from '../src/skills/types.js';
import { createSkillsTool } from '../src/tools/skills.js';

// Stubbed so a test run cannot append to the real daily log under the state dir.
vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

let dir = '';
let store: SkillStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-skills-'));
  store = new SkillStore({ dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const reservaDraft: SkillDraft = {
  name: 'Reservar mesa',
  description: 'Reserva de mesa en la web del restaurante',
  category: 'navegación',
  whenToUse: 'Cuando el usuario quiera reservar mesa',
  steps: ['Abrir la web del restaurante', 'Elegir día y hora', 'Confirmar la reserva'],
  notes: ['El restaurante cierra los lunes'],
};

const shortTranscript = [
  'usuario: dime qué hora es',
  'shell: date',
  'memory: guardar la hora',
  'agente: son las 10:20',
].join('\n');

const longTranscript = [
  'usuario: quiero publicar el informe semanal de ventas',
  'shell: ejecutar el script de datos',
  'fetch: leer la página de la competencia',
  'computer: screenshot',
  'computer: click',
  'shell: publicar el informe',
  'agente: listo, el informe semanal ya está publicado.',
].join('\n');

describe('SkillStore.save y list', () => {
  it('crea el SKILL.md con el frontmatter documentado y list lo parsea de vuelta', () => {
    const id = store.save(reservaDraft);
    expect(id).toBe('reservar-mesa');

    const file = join(dir, 'reservar-mesa', 'SKILL.md');
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('---');
    expect(text).toContain('name: Reservar mesa');
    expect(text).toContain('description: Reserva de mesa en la web del restaurante');
    expect(text).toContain('category: navegación');
    expect(text).toContain('when_to_use: Cuando el usuario quiera reservar mesa');
    expect(text).toContain('trust: community');
    expect(text).toContain('version: 1');
    expect(text).toContain('created_at:');
    expect(text).toContain('## Steps');
    expect(text).toContain('- Abrir la web del restaurante');
    expect(text).toContain('## Notes');
    expect(text).toContain('- El restaurante cierra los lunes');

    const parsed = store.list();
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      id: 'reservar-mesa',
      name: 'Reservar mesa',
      description: 'Reserva de mesa en la web del restaurante',
      category: 'navegación',
      whenToUse: 'Cuando el usuario quiera reservar mesa',
      steps: ['Abrir la web del restaurante', 'Elegir día y hora', 'Confirmar la reserva'],
      notes: ['El restaurante cierra los lunes'],
      version: 1,
      trust: 'community',
    });
    expect(store.read('reservar-mesa')).toEqual(parsed[0]);
  });

  it('guardar el mismo nombre actualiza ese skill y sube la versión', () => {
    const id = store.save(reservaDraft);
    const first = store.read(id);
    const again = store.save(reservaDraft);
    const skill = store.read(id);
    expect(again).toBe(id);
    expect(store.list()).toHaveLength(1);
    expect(skill?.version).toBe(2);
    expect(skill?.createdAt).toBe(first?.createdAt);
    // Notes must not stack when the same draft is saved twice.
    expect(skill?.notes).toEqual(['El restaurante cierra los lunes']);
  });
});

describe('SkillStore.improve', () => {
  it('sube la versión y deja nota del motivo con el diff de los pasos', () => {
    const id = store.save({
      name: 'Backup semanal',
      description: 'Copia de seguridad de la carpeta de trabajo',
      category: 'sistema',
      whenToUse: 'Cuando toque hacer la copia semanal',
      steps: ['Abrir el disco de destino', 'Copiar la carpeta de trabajo'],
    });

    store.improve(
      id,
      ['Abrir el disco de destino', 'Comprimir la copia', 'Subirla a la nube'],
      'La copia sin comprimir pesaba demasiado',
    );

    const skill = store.read(id);
    expect(skill?.version).toBe(2);
    expect(skill?.steps).toEqual([
      'Abrir el disco de destino',
      'Comprimir la copia',
      'Subirla a la nube',
    ]);
    const note = skill?.notes.at(-1) ?? '';
    expect(note).toMatch(/^\(\d{4}-\d{2}-\d{2}, v2\) /);
    expect(note).toContain('La copia sin comprimir pesaba demasiado');
    // A removed step is never destroyed: it must be readable in ## Notes.
    expect(note).toContain('[-] Copiar la carpeta de trabajo');
    expect(note).toContain('[+] Comprimir la copia');
    expect(note).toContain('[+] Subirla a la nube');

    store.improve(id, ['Solo un paso'], 'Segunda pasada');
    expect(store.read(id)?.version).toBe(3);
    expect(store.read(id)?.notes).toHaveLength(2);
    expect(() => store.improve('no-existe', ['x'], 'porque sí')).toThrow(/no hay ningun skill/);
    expect(() => store.improve(id, ['x'], '   ')).toThrow(/reason/);
    expect(() => store.improve(id, [], 'sin pasos')).toThrow(/newSteps/);
  });
});

describe('SkillStore.search', () => {
  it('encuentra por descripción, nombre o whenToUse', () => {
    store.save({
      name: 'Reservar mesa',
      description: 'Reserva de mesa en la web del restaurante',
      category: 'navegación',
      whenToUse: 'Cuando el usuario quiera comer fuera',
      steps: ['Abrir la web del restaurante', 'Elegir día y hora', 'Confirmar la reserva'],
    });
    store.save({
      name: 'Enviar informe',
      description: 'Genera el PDF del informe y lo manda por correo',
      category: 'general',
      whenToUse: 'Cuando el usuario pida el informe',
      steps: ['Generar el PDF', 'Enviarlo por correo'],
    });

    expect(store.search('restaurante').map((skill) => skill.id)).toEqual(['reservar-mesa']);
    expect(store.search('pdf').map((skill) => skill.id)).toEqual(['enviar-informe']);
    expect(store.search('enviar').map((skill) => skill.id)).toEqual(['enviar-informe']);
    expect(store.search('comer fuera').map((skill) => skill.id)).toEqual(['reservar-mesa']);
    expect(store.search('')).toEqual([]);
    expect(store.search('zzz nada')).toEqual([]);
  });
});

describe('SkillStore.export', () => {
  it('produce Markdown legible, listo para compartir como SKILL.md', () => {
    const id = store.save(reservaDraft);
    const text = store.export(id);
    expect(text.startsWith('---')).toBe(true);
    expect(text).toContain('name: Reservar mesa');
    expect(text).toContain('when_to_use: Cuando el usuario quiera reservar mesa');
    expect(text).toContain('## Steps');
    expect(text).toContain('- Confirmar la reserva');
    expect(text).toContain('## Notes');
    expect(text).toContain('- El restaurante cierra los lunes');
    expect(() => store.export('no-existe')).toThrow(/no hay ningun skill/);
  });
});

describe('decideToSave', () => {
  it('no vale la pena con solo dos tool calls', () => {
    const decision = decideToSave(shortTranscript, 'Son las 10:20.');
    expect(decision.worth).toBe(false);
    expect(decision.draft).toBeUndefined();
    expect(decision.reason).toMatch(/solo 2 distintas/);
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it('sí vale la pena con una tarea larga, novedosa y bien terminada', () => {
    const decision = decideToSave(longTranscript, 'Hecho: el informe semanal ya está publicado.');
    expect(decision.worth).toBe(true);
    expect(decision.draft?.steps).toEqual([
      'shell: ejecutar el script de datos',
      'fetch: leer la página de la competencia',
      'computer: screenshot',
      'computer: click',
      'shell: publicar el informe',
    ]);
    // whenToUse is derived from what the user actually asked for.
    expect(decision.draft?.whenToUse).toContain('informe semanal de ventas');
    expect(decision.draft?.name).toContain('informe semanal');
    expect(decision.reason).toContain('Merece la pena');
    expect(decision.reason).toContain('5 herramientas/acciones distintas');
  });

  it('no aprende de un fracaso ni duplica un skill parecido', () => {
    const failed = decideToSave(longTranscript, 'No he podido publicar el informe.');
    expect(failed.worth).toBe(false);
    expect(failed.reason).toMatch(/no fue un éxito/);

    const similar: Skill = {
      id: 'publicar-informe',
      name: 'publicar informe semanal',
      description: 'Publica el informe semanal de ventas',
      category: 'general',
      whenToUse: 'Cuando toque publicar el informe',
      steps: ['Ejecutar el script', 'Publicar el informe'],
      notes: [],
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      trust: 'community',
    };
    const duplicated = decideToSave(longTranscript, 'Hecho.', [similar]);
    expect(duplicated.worth).toBe(false);
    expect(duplicated.reason).toContain('publicar informe semanal');
  });

  it('lee también transcripciones con "herramienta:" y llamadas JSON', () => {
    const transcript = [
      'usuario: abre la web',
      'herramienta: computer',
      '{"name":"computer","arguments":{"action":"click","x":1,"y":2}}',
      'herramienta: shell: ejecutar',
    ].join('\n');
    expect(extractToolCalls(transcript)).toEqual([
      { tool: 'computer', action: '' },
      { tool: 'computer', action: 'click' },
      { tool: 'shell', action: 'ejecutar' },
    ]);
  });
});

describe('skills tool', () => {
  it('guarda, lista y busca a través de la tool', async () => {
    const tool = createSkillsTool({ store });
    const saved = await tool.execute(
      'call-1',
      {
        action: 'save',
        name: 'Pedir pizza',
        description: 'Pide la pizza de siempre en la web de siempre',
        category: 'general',
        whenToUse: 'Cuando el usuario pida pizza',
        steps: ['Abrir la web', 'Pedir la pizza de siempre'],
      },
      undefined,
      undefined,
    );
    expect(saved.content[0]).toMatchObject({ type: 'text' });
    expect(store.read('pedir-pizza')?.steps).toEqual(['Abrir la web', 'Pedir la pizza de siempre']);

    const listed = await tool.execute('call-2', { action: 'list' }, undefined, undefined);
    expect(listed.details).toMatchObject({ count: 1, ids: ['pedir-pizza'] });

    const found = await tool.execute(
      'call-3',
      { action: 'search', query: 'pizza' },
      undefined,
      undefined,
    );
    expect(found.details).toMatchObject({ count: 1 });
  });

  it('suggest propone un draft pero no guarda nada solo', async () => {
    const tool = createSkillsTool({ store });
    const suggested = await tool.execute(
      'call-4',
      {
        action: 'suggest',
        transcript: longTranscript,
        result: 'Hecho: el informe semanal ya está publicado.',
      },
      undefined,
      undefined,
    );
    expect(suggested.details).toMatchObject({ worth: true });
    expect(suggested.content[0]).toMatchObject({ type: 'text' });
    expect(store.list()).toEqual([]);
  });
});
