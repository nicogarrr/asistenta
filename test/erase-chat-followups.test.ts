import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FollowupTracker } from '../src/alerts/followups.js';
import { ERASE_PROMPT, eraseChat, eraseSummary } from '../src/erase-command.js';

/**
 * /borrar_chat decía «empezamos de cero», pero las notas de seguimiento del chat
 * («llamar a Juan el lunes») seguían ahí: el resumen diario y los avisos
 * proactivos volvían a sacar lo que Nico acababa de borrar.
 */
describe('/borrar_chat también quita los seguimientos del chat', () => {
  let dir: string;
  let db: DatabaseSync;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-erase-followups-'));
    db = new DatabaseSync(':memory:');
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('borra los del chat y sus temas, nunca los de un chat con el mismo prefijo', () => {
    const f = new FollowupTracker({ db });
    const due = Date.now() + 86_400_000;
    f.track('telegram:dm:1#main', 'date', 'llamar a Juan', due);
    f.track('telegram:dm:1#viaje', 'date', 'reservar hotel', due);
    f.track('telegram:dm:12#main', 'date', 'pagar el alquiler', due);
    f.track('telegram:dm:2#main', 'date', 'llamar a Juan', due);

    const r = eraseChat({ stateDir: dir, chatKey: 'telegram:dm:1', liveScopes: [], followups: f });

    expect(r.followups).toBe(2);
    expect(f.forChat('telegram:dm:1')).toEqual([]);
    expect(f.forChat('telegram:dm:12').map((n) => n.subject)).toEqual(['pagar el alquiler']);
    expect(f.forChat('telegram:dm:2').map((n) => n.subject)).toEqual(['llamar a Juan']);
    expect(eraseSummary(r)).toContain('2 seguimiento(s)');
  });

  it('sin seguimientos el resumen no los menciona', () => {
    const f = new FollowupTracker({ db });
    const r = eraseChat({ stateDir: dir, chatKey: 'telegram:dm:1', liveScopes: [], followups: f });
    expect(r.followups).toBe(0);
    expect(eraseSummary(r)).not.toContain('seguimiento');
  });

  it('el aviso dice que se van los seguimientos y que los objetivos aprobados se quedan', () => {
    expect(ERASE_PROMPT).toContain('seguimientos');
    expect(ERASE_PROMPT).toContain('objetivos aprobados se quedan');
  });
});
