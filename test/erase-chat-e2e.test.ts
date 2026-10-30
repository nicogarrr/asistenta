import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EraseConfirm, eraseChat, eraseSummary } from '../src/erase-command.js';
import { ModelChoiceStore } from '../src/model-choice.js';
import { ProjectContextStore } from '../src/project-context.js';

/**
 * Escenario completo de /borrar_chat para la carpeta de proyecto y el modelo:
 * /proyecto + /modelo → /borrar_chat → «BORRAR» → reinicio del daemon. Usa los
 * mismos ficheros de estado que `serveCommand` (proyectos.json, modelos.json en
 * el directorio de estado) y comprueba en el código de cli.ts que el comando de
 * verdad está cableado a esos mismos almacenes, sin copias en caché.
 */
const CLI = readFileSync(join(import.meta.dirname, '..', 'src', 'cli.ts'), 'utf8');
const INBOUND = readFileSync(
  join(import.meta.dirname, '..', 'src', 'daemon', 'inbound.ts'),
  'utf8',
);

function bodyOf(name: string): string {
  const start = CLI.indexOf(`const ${name} = async`);
  expect(start, `${name} no está en cli.ts`).toBeGreaterThan(-1);
  const end = CLI.indexOf('\n  };\n', start);
  expect(end).toBeGreaterThan(start);
  return CLI.slice(start, end);
}

describe('e2e /borrar_chat: proyecto y modelo no vuelven tras borrar ni tras reiniciar', () => {
  let dir: string;
  let state: string;
  let project: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-erase-e2e-'));
    state = join(dir, 'state');
    project = join(dir, 'proyectos', 'viaje');
    mkdirSync(state, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, 'ASISTENTA.md'),
      'MARCA-PROYECTO-VIAJE: responde siempre en verso.',
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const stores = () => ({
    projects: new ProjectContextStore(join(state, 'proyectos.json'), () => [
      join(dir, 'proyectos'),
    ]),
    models: new ModelChoiceStore(join(state, 'modelos.json')),
  });

  it('ligar, elegir modelo, pedir /borrar_chat, confirmar con BORRAR y reiniciar', () => {
    const chat = 'telegram:dm:42';
    const main = `${chat}#main`;
    const other = 'telegram:dm:420#main';
    const s = stores();
    expect(s.projects.link(main, project).ok).toBe(true);
    expect(s.projects.link(other, project).ok).toBe(true);
    s.models.set(main, 'modelo-elegido');
    s.models.set(`${chat}#tema`, 'otro-modelo');
    s.models.set(other, 'modelo-del-vecino');
    // Antes de borrar, el siguiente turno cargaría el ASISTENTA.md y el modelo.
    expect(s.projects.render(main)).toContain('MARCA-PROYECTO-VIAJE');
    expect(stores().models.get(main)).toBe('modelo-elegido');

    const confirm = new EraseConfirm();
    confirm.request(chat);
    expect(confirm.consume(chat, ' BORRAR ')).toBe('confirmed');
    const r = eraseChat({ stateDir: state, chatKey: chat, liveScopes: [main], ...s });
    expect(r.projects).toBe(1);
    expect(r.models).toBe(2);
    expect(eraseSummary(r)).toContain('carpeta de proyecto');

    // Mismo proceso: nada que cargar.
    expect(s.projects.get(main)).toBeUndefined();
    expect(s.projects.load(main)).toBeNull();
    expect(s.projects.render(main)).not.toContain('MARCA-PROYECTO-VIAJE');
    expect(s.models.get(main)).toBeUndefined();

    // Reinicio: instancias nuevas sobre los mismos ficheros tampoco lo ven.
    const after = stores();
    expect(after.projects.get(main)).toBeUndefined();
    expect(after.projects.render(main)).not.toContain('MARCA-PROYECTO-VIAJE');
    expect(after.models.get(main)).toBeUndefined();
    expect(after.models.get(`${chat}#tema`)).toBeUndefined();
    // El chat vecino que comparte prefijo sigue intacto.
    expect(after.projects.get(other)).toBe(project);
    expect(after.models.get(other)).toBe('modelo-del-vecino');
  });

  it('sin «BORRAR» exacto no se borra nada', () => {
    const chat = 'telegram:dm:42';
    const s = stores();
    s.models.set(`${chat}#main`, 'modelo-elegido');
    const confirm = new EraseConfirm();
    confirm.request(chat);
    expect(confirm.consume(chat, 'borrar')).toBe('cancelled');
    // La petición se gasta: un «BORRAR» después ya no confirma.
    expect(confirm.consume(chat, 'BORRAR')).toBeNull();
    expect(stores().models.get(`${chat}#main`)).toBe('modelo-elegido');
  });

  it('cli.ts: los almacenes del comando son los mismos que lee cada turno', () => {
    expect(CLI).toContain("new ProjectContextStore(join(paths.state, 'proyectos.json'))");
    expect(CLI).toContain("new ModelChoiceStore(join(paths.state, 'modelos.json'))");
    // El turno lee el almacén cada vez (sin copia en caché que sobreviva al borrado).
    expect(CLI).toMatch(/const savedModel = modelChoices\.get\(key\);/);
    expect(CLI).toMatch(/projectDir: projectContexts\.get\(thread\.key\)/);
  });

  it('cli.ts: «BORRAR» llega a cmdBorrarChatConfirmado, que borra proyecto, modelo e hilos vivos', () => {
    // The confirmation may live in cli.ts or, since the inbound-control move, in
    // src/daemon/inbound.ts with cli.ts wiring eraseConfirm and cmdBorrarChatConfirmado.
    const inline =
      /eraseConfirm\.consume\(chatKey_, inbound\.text\);\s*if \(erase === 'confirmed'\) return cmdBorrarChatConfirmado\(inbound\);/;
    if (!inline.test(CLI)) {
      expect(CLI).toMatch(/consumeErase: \(key, text\) => eraseConfirm\.consume\(key, text\),/);
      expect(CLI).toMatch(/eraseConfirmed: \(m\) => cmdBorrarChatConfirmado\(m\),/);
      expect(INBOUND).toMatch(
        /const erase = deps\.consumeErase\(key, inbound\.text\);\s*if \(erase === 'confirmed'\) \{\s*(return )?(await )?deps\.eraseConfirmed\(inbound\)/,
      );
    }
    const ask = bodyOf('cmdBorrarChat');
    expect(ask.indexOf('isOwnerDm(inbound')).toBeGreaterThan(-1);
    expect(ask.indexOf('isOwnerDm(inbound')).toBeLessThan(ask.indexOf('eraseConfirm.request('));
    const run = bodyOf('cmdBorrarChatConfirmado');
    expect(run.indexOf('isOwnerDm(inbound')).toBeGreaterThan(-1);
    expect(run.indexOf('isOwnerDm(inbound')).toBeLessThan(run.indexOf('eraseChat('));
    expect(run).toMatch(/stateDir: paths\.state/);
    expect(run).toMatch(/projects: projectContexts/);
    expect(run).toMatch(/models: modelChoices/);
    // Los hilos vivos se descartan: el siguiente mensaje crea uno nuevo que relee el modelo.
    expect(run).toMatch(/threads\.delete\(t\.key\)/);
  });
});
