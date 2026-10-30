// Auditoria de context engineering: el texto que el agente guardo antes (un
// hecho de memoria, el resumen de una sesion, un frente de trabajo, el nombre
// de una rutina) vuelve al prompt dentro de los bloques cercados de la nota de
// contexto (<memory>, <historial>, <workstreams>, <routines>). Ese texto pudo
// venir de una web o de un resultado de herramienta que el modelo releyo, y un
// valor con la etiqueta de cierre romperia la cerca y se haria pasar por
// marcado del prompt. skillsIndex ya lo neutralizaba para <skills>; estos
// tests fijan la misma defensa en los demas bloques, siempre en el render: lo
// almacenado no se reescribe.
// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que paths.ts lo capture
import './factory-test-env.js';
import { mkdtempSync } from 'node:fs';
import { Store } from '../src/db.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildContextNote } from '../src/cli.js';
import { MemorySnapshot } from '../src/memory/snapshot.js';
import { MemoryStore } from '../src/memory.js';
import { createMemoryTool } from '../src/tools/memory.js';

// El perfil del dueño (PERFIL.md) es de Nico. Antes se inyectaba en el prompt de
// TODOS los chats (grupos y otros usuarios autorizados incluidos) y cualquiera podía
// escribirlo con save_profile.
const SECRET_FACT = 'Nico cobra la nómina el día 28 en el BBVA';

function snapshotWithFact() {
  const dir = mkdtempSync(join(tmpdir(), 'pa-perfil-'));
  const snapshot = new MemorySnapshot({ dir });
  expect(snapshot.appendEntry(SECRET_FACT).ok).toBe(true);
  return { dir, snapshot };
}

describe('el perfil del dueño solo existe en su chat privado', () => {
  it('buildContextNote NO mete el perfil en un chat que no es el DM del dueño', () => {
    const { snapshot } = snapshotWithFact();
    const dir = mkdtempSync(join(tmpdir(), 'pa-ctx-'));
    const store = new Store(join(dir, 'db.sqlite'));
    const memory = new MemoryStore(join(dir, 'memory'));
    const note = buildContextNote(
      { key: 'telegram:main:-100123:main', name: 'grupo' },
      store,
      memory,
      snapshot,
    );
    expect(note).not.toContain('nómina');
  });

  it('en el DM del dueño (ownerView) el perfil sigue entrando', () => {
    const { snapshot } = snapshotWithFact();
    const dir = mkdtempSync(join(tmpdir(), 'pa-ctx-'));
    const store = new Store(join(dir, 'db.sqlite'));
    const memory = new MemoryStore(join(dir, 'memory'));
    const note = buildContextNote(
      { key: 'telegram:main:42:main', name: 'principal' },
      store,
      memory,
      snapshot,
      undefined,
      undefined,
      undefined,
      undefined,
      'hola',
      true,
    );
    expect(note).toContain('nómina');
  });

  it('save_profile desde otro chat no escribe el PERFIL.md del dueño', async () => {
    const { dir, snapshot } = snapshotWithFact();
    const memory = new MemoryStore(join(dir, 'memory'));
    let ownerChat = false;
    const tool = createMemoryTool(
      memory,
      () => 'telegram:main:-100123:main',
      () => (ownerChat ? snapshot : undefined),
    );
    const r = await tool.execute('1', { action: 'save_profile', text: 'Nico odia el cilantro' });
    expect(r.isError).toBe(true);
    expect(snapshot.load()).not.toContain('cilantro');
    const shown = await tool.execute('2', { action: 'profile' });
    expect(JSON.stringify(shown.content)).not.toContain('nómina');
    ownerChat = true;
    await tool.execute('3', { action: 'save_profile', text: 'Nico odia el cilantro' });
    expect(snapshot.load()).toContain('cilantro');
  });
});
