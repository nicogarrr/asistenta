import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AskFirstStore, askFirstFromText, askFirstRequest } from '../src/preguntar-antes.js';

// bugs-35 (revisión de #2337, reglas por chat): en un grupo el bot solo atiende si lo
// mencionan, y el texto llega con la mención dentro («@asistenta_bot pregúntame antes de
// usar el navegador»). `askFirstRequest` exigía que la frase EMPEZARA por «pregúntame», así
// que en un grupo nunca se apuntaba la regla (solo contestando a un mensaje del bot), y con
// la mención al final la guardaba con «@asistenta_bot» en lo dicho.

describe('«pregúntame antes de …» con la mención del bot (grupos)', () => {
  it('la mención al principio o al final no impide reconocerla', () => {
    expect(askFirstRequest('@asistenta_bot pregúntame antes de usar el navegador')).toBe(
      'usar el navegador',
    );
    expect(askFirstRequest('@Asistenta_Bot, pregúntame antes de tocar la tele')).toBe(
      'tocar la tele',
    );
    expect(askFirstRequest('pregúntame antes de poner música @asistenta_bot')).toBe('poner música');
  });

  it('en un grupo, con la mención, apunta la regla solo para ese grupo', () => {
    const store = new AskFirstStore(join(mkdtempSync(join(tmpdir(), 'bugs35-af-')), 'r.json'));
    const reply = askFirstFromText(store, '@asistenta_bot pregúntame antes de usar el navegador', {
      chat: 'telegram:main:-100123',
      group: true,
    });
    expect(reply).not.toBeNull();
    const rules = store.list();
    expect(rules).toHaveLength(1);
    expect(rules[0]?.chat).toBe('telegram:main:-100123');
    expect(rules[0]?.dicho).not.toContain('@');
  });

  it('sigue sin saltar con otras frases', () => {
    expect(askFirstRequest('@asistenta_bot ¿qué tiempo hace?')).toBeNull();
    expect(askFirstRequest('dile a @pepe pregúntame antes de salir')).toBeNull();
  });
});
