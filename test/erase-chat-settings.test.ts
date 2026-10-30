import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eraseChat, eraseSummary, isKeyOfChat } from '../src/erase-command.js';
import { ModelChoiceStore } from '../src/model-choice.js';
import { ProjectContextStore } from '../src/project-context.js';

/**
 * /borrar_chat promete «empezamos de cero», pero la carpeta ligada con /proyecto y el
 * modelo elegido con /modelo sobrevivían: tras borrar, el siguiente turno seguía
 * cargando el ASISTENTA.md del proyecto y hablando con otro modelo.
 */
describe('/borrar_chat también quita los ajustes del chat', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-erase-settings-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const seed = (file: string, data: Record<string, string>): void => {
    writeFileSync(file, JSON.stringify(data));
  };

  it('borra modelo y proyecto del chat y sus temas, nunca de un chat con el mismo prefijo', () => {
    const modelsFile = join(dir, 'modelos.json');
    const projFile = join(dir, 'proyectos.json');
    seed(modelsFile, {
      'telegram:dm:1#main': 'm-a',
      'telegram:dm:1#viaje': 'm-b',
      'telegram:dm:12#main': 'm-c',
    });
    seed(projFile, { 'telegram:dm:1#main': '/p/uno', 'telegram:dm:12#main': '/p/doce' });
    const models = new ModelChoiceStore(modelsFile);
    const projects = new ProjectContextStore(projFile, () => [dir]);

    const r = eraseChat({
      stateDir: dir,
      chatKey: 'telegram:dm:1',
      liveScopes: [],
      projects,
      models,
    });

    expect(r.models).toBe(2);
    expect(r.projects).toBe(1);
    expect(models.get('telegram:dm:1#main')).toBeUndefined();
    expect(models.get('telegram:dm:1#viaje')).toBeUndefined();
    expect(models.get('telegram:dm:12#main')).toBe('m-c');
    expect(projects.get('telegram:dm:1#main')).toBeUndefined();
    expect(projects.get('telegram:dm:12#main')).toBe('/p/doce');
    // Persistido: una instancia nueva (reinicio) tampoco lo ve.
    expect(JSON.parse(readFileSync(projFile, 'utf8'))).toEqual({
      'telegram:dm:12#main': '/p/doce',
    });
    expect(new ModelChoiceStore(modelsFile).get('telegram:dm:1#viaje')).toBeUndefined();
    expect(eraseSummary(r)).toContain('carpeta de proyecto');
    expect(eraseSummary(r)).toContain('/modelo');
  });

  it('sin ajustes guardados no toca los ficheros y el resumen no los menciona', () => {
    const models = new ModelChoiceStore(join(dir, 'nada.json'));
    const projects = new ProjectContextStore(join(dir, 'nada2.json'), () => [dir]);
    const r = eraseChat({
      stateDir: dir,
      chatKey: 'telegram:dm:1',
      liveScopes: [],
      projects,
      models,
    });
    expect(r.models).toBe(0);
    expect(r.projects).toBe(0);
    expect(eraseSummary(r)).not.toContain('proyecto');
    expect(eraseSummary(r)).not.toContain('/modelo');
  });

  it('isKeyOfChat no confunde chats que comparten prefijo', () => {
    expect(isKeyOfChat('telegram:dm:1', 'telegram:dm:1')).toBe(true);
    expect(isKeyOfChat('telegram:dm:1#x', 'telegram:dm:1')).toBe(true);
    expect(isKeyOfChat('telegram:dm:12#main', 'telegram:dm:1')).toBe(false);
  });
});
