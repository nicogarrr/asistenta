import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatApproval } from '../src/approval-text.js';
import {
  ADJUNTOS_MAX_BYTES,
  cargarAdjuntos,
  configurarAdjuntos,
  lineasAdjuntos,
  mirarAdjunto,
} from '../src/mail/adjuntos.js';
import type { SendRequest } from '../src/mail/types.js';
import type { ToolCall } from '../src/permissions.js';
import { type MailToolDeps, runMailTool } from '../src/tools/mail.js';

let base: string;
let state: string;
let creados: string;
let docs: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'gaps10-adj-'));
  state = join(base, 'estado');
  creados = join(state, 'creados');
  docs = join(base, 'home', 'Documentos');
  mkdirSync(creados, { recursive: true });
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(creados, '20261111-120000-grafica.png'), Buffer.alloc(2048, 1));
  writeFileSync(join(docs, 'tesis ASTS.pdf'), Buffer.alloc(5000, 2));
  writeFileSync(join(state, 'agent.db'), 'x');
  mkdirSync(join(base, 'home', '.ssh'), { recursive: true });
  writeFileSync(join(base, 'home', '.ssh', 'id_rsa'), 'secreto');
  writeFileSync(join(docs, 'claves.pem'), 'secreto');
  configurarAdjuntos({ creadosDir: creados, stateDir: state, roots: [docs] });
});
afterEach(() => configurarAdjuntos(null));

const reader = { address: 'nico@gmail.com', password: 'x', imapHost: 'h', imapPort: 993 };
const sender = { ...reader, smtpHost: 'smtp', smtpPort: 465 };
function deps() {
  const sent: SendRequest[] = [];
  const d: MailToolDeps = {
    allowed: () => true,
    account: async () => reader,
    search: async () => [],
    read: async () => null,
    sendAccount: async () => sender,
    send: async (_a, req) => {
      sent.push(req);
      return { ok: true, id: '<n@x>' };
    },
  };
  return { d, sent };
}
const nuevo = (adjuntos: string[]) => ({
  action: 'nuevo',
  para: ['gestor@ejemplo.es'],
  asunto: 'La tesis',
  cuerpo: 'Te paso la tesis y la gráfica.',
  adjuntos,
});
const ask = (args: Record<string, unknown>) =>
  formatApproval({ tool: 'correo', args, actor: 'asistenta' } as ToolCall, 'lo pidió Nico');

describe('correo con adjuntos (Grok Bot: el borrador lleva los ficheros preparados)', () => {
  it('la aprobación enseña cada adjunto con nombre y tamaño, y sale exactamente eso', async () => {
    const args = nuevo(['grafica.png', join(docs, 'tesis ASTS.pdf')]);
    const q = ask(args);
    expect(q.complete).toBe(true);
    expect(q.question).toContain('Adjuntos (2):');
    expect(q.question).toContain('📎 grafica.png (2 KB)');
    expect(q.question).toContain('📎 tesis ASTS.pdf (5 KB)');
    const { d, sent } = deps();
    const out = await runMailTool(args, d);
    expect(out).toContain('con 2 adjunto(s)');
    expect(sent[0]?.attachments?.map((f) => [f.filename, f.content.length])).toEqual([
      ['grafica.png', 2048],
      ['tesis ASTS.pdf', 5000],
    ]);
  });

  it('si el fichero cambia después de aprobarlo, no sale nada', async () => {
    const pdf = join(docs, 'tesis ASTS.pdf');
    const args = nuevo([pdf]);
    ask(args);
    writeFileSync(pdf, Buffer.alloc(6000, 3));
    utimesSync(pdf, new Date(), new Date(Date.now() + 5000));
    const { d, sent } = deps();
    const out = await runMailTool(args, d);
    expect(out).toMatch(/^No enviado: «tesis ASTS\.pdf» cambió después/);
    expect(sent).toEqual([]);
  });

  it('un adjunto que no salía en el borrador aprobado no se envía', async () => {
    const { d, sent } = deps();
    const out = await runMailTool(nuevo(['grafica.png']), d);
    expect(out).toContain('no salía en el borrador que aprobaste');
    expect(sent).toEqual([]);
  });

  it('nada oculto, ni claves, ni el estado interno, ni fuera de las carpetas permitidas', () => {
    expect(mirarAdjunto(join(base, 'home', '.ssh', 'id_rsa'))).toMatchObject({ ok: false });
    expect(mirarAdjunto(join(docs, 'claves.pem'))).toMatchObject({
      ok: false,
      why: 'parece una clave o datos privados',
    });
    expect(mirarAdjunto(join(state, 'agent.db'))).toMatchObject({ ok: false });
    writeFileSync(join(base, 'fuera.txt'), 'x');
    expect(mirarAdjunto(join(base, 'fuera.txt'))).toMatchObject({ ok: false });
    expect(mirarAdjunto(join(docs, '..', '.ssh', 'id_rsa'))).toMatchObject({ ok: false });
    expect(mirarAdjunto('no-existe.png')).toMatchObject({ ok: false });
    expect(lineasAdjuntos([join(docs, 'claves.pem')])).toContain('✗');
  });

  it('lo que te hice se encuentra por su nombre de a pie («Gastos de octubre.xlsx»)', () => {
    writeFileSync(join(creados, '20261110-200000-Gastos-de-octubre.xlsx'), Buffer.alloc(100));
    expect(mirarAdjunto('Gastos de octubre.xlsx')).toMatchObject({
      ok: true,
      name: 'Gastos-de-octubre.xlsx',
      size: 100,
    });
    expect(mirarAdjunto('20261110-200000-Gastos-de-octubre.xlsx')).toMatchObject({ ok: true });
  });

  it('el tope de tamaño corta el envío entero', () => {
    const big = join(docs, 'grande.mp4');
    writeFileSync(big, Buffer.alloc(ADJUNTOS_MAX_BYTES + 1));
    lineasAdjuntos([big]);
    expect(cargarAdjuntos([big])).toMatchObject({ ok: false });
  });

  it('sin adjuntos, el borrador y el envío son los de siempre', async () => {
    const args = { ...nuevo([]), adjuntos: undefined };
    expect(ask(args).question).not.toContain('Adjuntos');
    const { d, sent } = deps();
    await runMailTool(args, d);
    expect(sent[0]?.attachments).toBeUndefined();
  });
});
