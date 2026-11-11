import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventoLocalIcs } from '../src/agenda/ics-iphone.js';
import { appendEvent, localUidHash } from '../src/agenda/write.js';
import { commandButton, commandFromCallback } from '../src/channels/telegram-shared.js';
import { DEFAULT_SCOPES, GOOGLE_KEYS } from '../src/google/oauth.js';
import { resetWorkspaceForTests } from '../src/google/workspace.js';
import { createGoogleTool } from '../src/tools/google.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-gaps16-ics-'));
  resetWorkspaceForTests();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('gaps-16: «📲 .ics (iPhone)» de /calendario add', () => {
  it('el botón lleva el UID del evento y saca ESE evento del local.ics', async () => {
    const file = join(dir, 'local.ics');
    const start = new Date('2026-11-20T08:30:00Z');
    await appendEvent(file, { title: 'Dentista, revisión', start });
    await appendEvent(file, { title: 'Otro', start: new Date('2026-11-21T10:00:00Z') });
    const hash = localUidHash('Dentista, revisión', start);
    const cal = readFileSync(file, 'utf8');
    // El UID que escribe appendEvent no cambia (eventos ya apuntados siguen igual).
    expect(cal).toContain(`UID:${hash}@asistenta.local`);
    const btn = commandButton('📲 .ics (iPhone)', 'calendario', hash, 'ics');
    expect(commandFromCallback(btn?.action ?? '')).toBe(`/calendario ics ${hash}`);
    const ev = eventoLocalIcs(cal, hash);
    expect(ev?.titulo).toBe('Dentista, revisión');
    expect(ev?.nombre).toBe('Dentista, revisión.ics');
    expect(ev?.ics).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(ev?.ics).toContain('METHOD:PUBLISH');
    expect(ev?.ics).toContain('DTSTART:20261120T083000Z');
    expect(ev?.ics).not.toContain('SUMMARY:Otro');
    expect(ev?.ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    // Borrado o inventado: nada.
    expect(eventoLocalIcs(cal, 'f'.repeat(20))).toBeNull();
    expect(eventoLocalIcs(cal, '../etc')).toBeNull();
  });

  it('cli: la confirmación de /calendario lleva el botón y «ics» lee el local.ics', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');
    expect(src).toMatch(
      /commandButton\(\s*'📲 \.ics \(iPhone\)',\s*'calendario',\s*localUidHash\(title, start\),\s*'ics',?\s*\)/,
    );
    expect(src).toContain('const ev = eventoLocalIcs(cal, icsArg[1]');
  });
});

function vault(connected: boolean) {
  const m = new Map<string, string>([
    [GOOGLE_KEYS.clientId, 'cid.apps.googleusercontent.com'],
    [GOOGLE_KEYS.clientSecret, 'sec'],
    [GOOGLE_KEYS.scopes, DEFAULT_SCOPES.join(' ')],
  ]);
  if (connected) m.set(GOOGLE_KEYS.refreshToken, 'RT');
  return {
    get: async (k: string) => m.get(k),
    set: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
  };
}
const ok = (async (url: string) =>
  String(url).includes('oauth2.googleapis.com/token')
    ? new Response(JSON.stringify({ access_token: 'AT', expires_in: 3600 }), { status: 200 })
    : new Response(JSON.stringify({ id: 'E1', start: { dateTime: '2026-11-20T09:30:00+01:00' } }), {
        status: 200,
      })) as typeof fetch;
const text = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? '').join('');

describe('gaps-16: evento_crear sin Google → el .ics para el iPhone', () => {
  const args = {
    action: 'evento_crear' as const,
    titulo: 'Comité de inversión',
    inicio: '2026-11-20T09:30',
    lugar: 'Teams',
  };

  it('Google sin conectar: le llega el .ics y el modelo lo sabe', async () => {
    const enviarIcs = vi.fn(async () => true);
    const tool = createGoogleTool({
      google: () => ({ vault: vault(false), fetch: ok, timeZone: () => 'Europe/Madrid' }),
      allowed: () => true,
      enviarIcs,
    });
    const r = await tool.execute('t1', args as never);
    expect(enviarIcs).toHaveBeenCalledTimes(1);
    const [bytes, name, caption] = enviarIcs.mock.calls[0] as unknown as [Buffer, string, string];
    const ics = bytes.toString('utf8');
    expect(ics).toContain('SUMMARY:Comité de inversión');
    expect(ics).toContain('DTSTART:20261120T083000Z');
    expect(ics).toContain('LOCATION:Teams');
    expect(name).toBe('Comité de inversión.ics');
    expect(caption).toContain('📲');
    expect(text(r as never)).toContain('.ics');
  });

  it('apuntado en Google: no manda nada; sin título o sin hora, tampoco', async () => {
    const enviarIcs = vi.fn(async () => true);
    const tool = createGoogleTool({
      google: () => ({ vault: vault(true), fetch: ok, timeZone: () => 'Europe/Madrid' }),
      allowed: () => true,
      enviarIcs,
    });
    const r = await tool.execute('t2', args as never);
    expect(text(r as never)).toMatch(/^📅 Apuntado/);
    const sinConectar = createGoogleTool({
      google: () => ({ vault: vault(false), fetch: ok }),
      allowed: () => true,
      enviarIcs,
    });
    await sinConectar.execute('t3', { action: 'evento_crear', titulo: 'X' } as never);
    expect(enviarIcs).not.toHaveBeenCalled();
  });
});
