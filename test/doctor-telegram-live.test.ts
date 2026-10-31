/**
 * `pa doctor` solo miraba la forma del token del bot. Un token revocado o mal
 * copiado pasaba como bueno y Asistenta no arrancaba. Ahora prueba getMe de
 * verdad (con fetch falso aquí), sin mostrar nunca el token, y sin red no falla.
 */
import { describe, expect, it } from 'vitest';
import {
  type DoctorFetch,
  doctorFetch,
  telegramDoctorLines,
  telegramLiveLine,
} from '../src/doctor-telegram.js';

const TOKEN = `123456789:${'A'.repeat(35)}`;
const vault = async (k: string) =>
  ({ 'telegram:botToken': TOKEN, 'telegram:allowedUserIds': '111' })[k];

const answer =
  (status: number, body: unknown): DoctorFetch =>
  async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('pa doctor: prueba en vivo del token de Telegram', () => {
  it('token bueno: dice el nombre del bot y nunca el token', async () => {
    const urls: string[] = [];
    const f: DoctorFetch = async (url, init) => {
      urls.push(url);
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return answer(200, { ok: true, result: { username: 'MiAsistentaBot' } })(url, init);
    };
    const lines = await telegramDoctorLines(vault, f);
    expect(urls).toEqual([`https://api.telegram.org/bot${TOKEN}/getMe`]);
    expect(lines).toContain('telegram        Telegram reconoce tu bot @MiAsistentaBot');
    expect(lines.join('\n')).not.toContain('AAAA');
  });

  it('token revocado o mal copiado (401/404): lo dice claro', async () => {
    for (const st of [401, 404]) {
      const line = await telegramLiveLine(TOKEN, answer(st, { ok: false }));
      expect(line).toMatch(/^telegram +Telegram dice que este token no vale/);
      expect(line).toContain('instalar.bat');
    }
  });

  it('sin internet: no falla ni enseña el error crudo (que lleva el token)', async () => {
    const f: DoctorFetch = async (url) => {
      throw new Error(`fetch failed ${url}`);
    };
    const lines = await telegramDoctorLines(vault, f);
    const line = lines.find((l) => l.includes('Telegram'));
    expect(line).toMatch(/sin internet/);
    expect(lines.join('\n')).not.toMatch(/AAAA|fetch failed|api\.telegram/);
  });

  it('Telegram que no contesta: corta en poco tiempo', async () => {
    const f: DoctorFetch = () => new Promise(() => {});
    const t0 = Date.now();
    const line = await telegramLiveLine(TOKEN, f, 50);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(line).toMatch(/sin internet/);
  });

  it('respuesta rara o 500: frase llana, sin datos del servidor', async () => {
    expect(await telegramLiveLine(TOKEN, answer(500, {}))).toMatch(/no responde bien/);
    expect(await telegramLiveLine(TOKEN, answer(200, { ok: false }))).toMatch(
      /no ha confirmado el bot/,
    );
    expect(
      await telegramLiveLine(TOKEN, answer(200, { ok: true, result: { username: '<b>x' } })),
    ).toBe('telegram        Telegram reconoce tu bot');
  });

  it('sin token o con forma mala no llama a Telegram; PA_DOCTOR_SIN_RED=1 la apaga', async () => {
    let calls = 0;
    const f: DoctorFetch = async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    await telegramDoctorLines(async () => undefined, f);
    await telegramDoctorLines(async (k) => (k === 'telegram:botToken' ? 'xx' : '1'), f);
    expect(calls).toBe(0);
    expect(doctorFetch({ PA_DOCTOR_SIN_RED: '1' })).toBeUndefined();
    expect(typeof doctorFetch({})).toBe('function');
  });
});
