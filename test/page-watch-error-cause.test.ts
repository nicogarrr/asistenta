import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { pageNotice } from '../src/cli.js';
import { type CheckOutcome, PageWatchStore } from '../src/watch/pages.js';

const URL = 'https://ejemplo.es/noticias';

function notice(message: string): string {
  const s = new PageWatchStore(new DatabaseSync(':memory:'), () => 5);
  const w = s.add('chat1', URL, 'Noticias');
  const o = { kind: 'error', message, failures: 3, notify: true } as CheckOutcome;
  return pageNotice(w, o, 5)?.text ?? '';
}

describe('aviso «No consigo leer…» sin errores en inglés', () => {
  it.each([
    ['fetch failed', 'sin conexión'],
    ['This operation was aborted', 'tarda demasiado'],
    ['HTTP 403 Forbidden', 'no me deja entrar'],
    ['HTTP 404 Not Found', 'ya no existe'],
    ['Request failed with status 503', 'da error'],
    ['getaddrinfo ENOTFOUND ejemplo.es', 'sin conexión'],
  ])('%s → %s', (raw, cause) => {
    const text = notice(raw);
    expect(text).toContain('No consigo leer');
    expect(text).toContain(cause);
    expect(text).not.toContain(raw);
  });

  it('un mensaje propio en castellano se respeta', () => {
    expect(notice('no encuentro un precio claro en la ficha; no se pudo comprobar')).toContain(
      'no encuentro un precio claro',
    );
  });

  it('un error raro en inglés no sale tal cual', () => {
    const text = notice("Cannot read properties of undefined (reading 'body')");
    expect(text).not.toMatch(/Cannot read|undefined/);
  });
});
