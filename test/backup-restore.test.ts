/**
 * Copia y restauración del estado con la API real de `src/backup.ts`.
 *
 * La copia se hace con `runBackup`. El módulo NO expone una API de restore: su
 * propia cabecera documenta el procedimiento manual (copiar las bases y
 * carpetas de la fecha elegida encima del directorio de estado). El segundo
 * test ejercita exactamente ese procedimiento y comprueba que el contenido
 * vuelve a ser idéntico; no se inventa una función de restore en producción.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { runBackup } from '../src/backup.js';

const MEMORY_TEXT = '# Memory for telegram:main:1#main\n\n- [m1] (2026-10-20) recuerdo\n';
const PROFILE_TEXT = '[]\n';
const SKILL_TEXT = '# Skill\n\nPasos de la skill.\n';

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function readValue(dbPath: string): string {
  const db = new DatabaseSync(dbPath);
  try {
    return (
      db.prepare('SELECT valor FROM memoria WHERE clave = ?').get('nombre') as {
        valor: string;
      }
    ).valor;
  } finally {
    db.close();
  }
}

/** Estado mínimo pero realista: memoria, perfil, skills y una base sqlite. */
function stateWithData(): string {
  const stateDir = tempDir('pa-backup-');
  mkdirSync(join(stateDir, 'memory'));
  writeFileSync(join(stateDir, 'memory', 'nota.md'), MEMORY_TEXT);
  mkdirSync(join(stateDir, 'profile'));
  writeFileSync(join(stateDir, 'profile', '1.json'), PROFILE_TEXT);
  mkdirSync(join(stateDir, 'skills', 'reservar'), { recursive: true });
  writeFileSync(join(stateDir, 'skills', 'reservar', 'SKILL.md'), SKILL_TEXT);

  const db = new DatabaseSync(join(stateDir, 'agent.db'));
  try {
    db.exec('CREATE TABLE memoria (clave TEXT PRIMARY KEY, valor TEXT NOT NULL)');
    db.prepare('INSERT INTO memoria (clave, valor) VALUES (?, ?)').run('nombre', 'Nico');
  } finally {
    db.close();
  }
  return stateDir;
}

/** Restauración documentada: sustituir lo que viaja en la copia por la copia. */
function restoreFromBackup(backupDir: string, stateDir: string): void {
  for (const name of readdirSync(backupDir)) {
    const target = join(stateDir, name);
    rmSync(target, { recursive: true, force: true });
    cpSync(join(backupDir, name), target, { recursive: true });
  }
}

afterEach(() => {
  for (const dir of dirs)
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  dirs.length = 0;
});

describe('copia de seguridad', () => {
  it('copia memoria, skills, la base y el perfil', () => {
    const stateDir = stateWithData();
    const result = runBackup({ stateDir, now: new Date(2026, 9, 26, 3, 5) });

    expect(result.dir).toBe(join(stateDir, 'backups', '2026-10-26'));
    expect(result.databases).toEqual(['agent.db']);
    expect(result.copiedDirs).toEqual(expect.arrayContaining(['memory', 'skills']));

    expect(readFileSync(join(result.dir, 'memory', 'nota.md'), 'utf8')).toBe(MEMORY_TEXT);
    expect(readFileSync(join(result.dir, 'skills', 'reservar', 'SKILL.md'), 'utf8')).toBe(
      SKILL_TEXT,
    );
    expect(readValue(join(result.dir, 'agent.db'))).toBe('Nico');

    // `profile/` ya entra en la copia (antes quedaba fuera: limitación cerrada).
    expect(readFileSync(join(result.dir, 'profile', '1.json'), 'utf8')).toBe(PROFILE_TEXT);
  });
});

describe('restauración (sin API: procedimiento documentado)', () => {
  it('devuelve el contenido original tras corromperlo y aplicar la copia', () => {
    const stateDir = stateWithData();
    const result = runBackup({ stateDir, now: new Date(2026, 9, 26, 3, 5) });

    // Se cambia el original a propósito: memoria, skill, base y perfil.
    writeFileSync(join(stateDir, 'memory', 'nota.md'), 'corrupto\n');
    writeFileSync(join(stateDir, 'skills', 'reservar', 'SKILL.md'), 'corrupto\n');
    writeFileSync(join(stateDir, 'profile', '1.json'), 'perfil cambiado\n');
    const db = new DatabaseSync(join(stateDir, 'agent.db'));
    try {
      db.prepare('UPDATE memoria SET valor = ? WHERE clave = ?').run('otro', 'nombre');
    } finally {
      db.close();
    }

    restoreFromBackup(result.dir, stateDir);

    expect(readFileSync(join(stateDir, 'memory', 'nota.md'), 'utf8')).toBe(MEMORY_TEXT);
    expect(readFileSync(join(stateDir, 'skills', 'reservar', 'SKILL.md'), 'utf8')).toBe(SKILL_TEXT);
    expect(readValue(join(stateDir, 'agent.db'))).toBe('Nico');
    // El perfil también vuelve: la restauración ya es total para estos datos.
    expect(readFileSync(join(stateDir, 'profile', '1.json'), 'utf8')).toBe(PROFILE_TEXT);
  });
});
