import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { summarize } from '../src/tools/mail-rules.js';

describe('resumen del correo: asunto sospechoso con emoji en el corte', () => {
  it('no deja medio emoji (Telegram rechaza el texto o enseña «�»)', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'bugs17-correo-')), 'rules.json');
    const subject = `${'a'.repeat(59)}🎁 regalo`;
    const text = summarize([{ from: 'no-reply@paypa1.com', subject, headers: '' }] as never, file);
    expect(text).toContain(`⚠️ posible estafa: «${'a'.repeat(59)}» de no-reply@paypa1.com`);
    expect(text.isWellFormed()).toBe(true);
  });
});
