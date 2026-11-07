import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  asuntoOrden,
  cuerpoOrden,
  OrdenesStore,
  recetasOrdenes,
  registrarResultado,
  resumenOrden,
  validarOrden,
} from '../src/iphone/ordenes.js';
import { Gate } from '../src/permissions.js';
import { createIphoneOrdenTool, type IphoneOrdenDeps } from '../src/tools/iphone-orden.js';
import { startWebUi } from '../src/webui/server.js';

// Órdenes de Asistenta al iPhone por correo (Nico, 7 nov: «quiero hacerlo yo, con Asistenta»).
// Asistenta manda un correo «ASIS-<clave> <acción> #<id>» con una línea JSON; una
// automatización de Atajos lo ejecuta y confirma en /api/atajo/resultado. Sin iPhone real.

const dirs: string[] = [];
function tmpStore(now?: () => number): OrdenesStore {
  const dir = mkdtempSync(join(tmpdir(), 'pa-ordenes-'));
  dirs.push(dir);
  return new OrdenesStore(join(dir, 'iphone-ordenes.json'), now);
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

type Envio = { to: string; subject: string; text: string };
function toolCon(store: OrdenesStore, extra: Partial<IphoneOrdenDeps> = {}) {
  const enviados: Envio[] = [];
  const avisos: string[] = [];
  const tool = createIphoneOrdenTool({
    store,
    correos: async () => ({ iphone: 'nico@icloud.com', remitente: 'asistenta@gmail.com' }),
    enviar: async (to, subject, text) => {
      enviados.push({ to, subject, text });
      return { ok: true };
    },
    avisar: async (t) => {
      avisos.push(t);
    },
    esperaMs: 0,
    ...extra,
  });
  const run = async (args: Record<string, unknown>) => {
    const r = await tool.execute('t', args as never);
    return (r.content[0] as { text: string }).text;
  };
  return { tool, run, enviados, avisos };
}

describe('formato de la orden', () => {
  it('valida lo que falta por acción', () => {
    expect(validarOrden('whatsapp', { para: 'Mamá' })).toEqual({
      error: 'Para «whatsapp» falta: texto.',
    });
    expect(validarOrden('evento', { titulo: 'Dentista' })).toHaveProperty('error');
    expect(validarOrden('abrir_app', { app: ' Spotify ' })).toEqual({ params: { app: 'Spotify' } });
  });

  it('quita caracteres de control y deja una sola línea JSON legible por Atajos', () => {
    const v = validarOrden('whatsapp', { para: 'Mamá', texto: 'Llego\u0007 en 10\nbesos' });
    expect('params' in v).toBe(true);
    if (!('params' in v)) return;
    const cuerpo = cuerpoOrden({ id: 3, accion: 'whatsapp', ...v.params });
    expect(cuerpo.includes('\n')).toBe(false);
    expect(JSON.parse(cuerpo)).toEqual({
      id: 3,
      accion: 'whatsapp',
      para: 'Mamá',
      texto: 'Llego en 10\nbesos',
    });
  });

  it('el asunto lleva la clave, la acción y el número', () => {
    expect(asuntoOrden('abc23xyz', { id: 7, accion: 'musica', busqueda: 'Rosalía' })).toBe(
      'ASIS-abc23xyz musica #7',
    );
    expect(resumenOrden({ accion: 'musica', busqueda: 'Rosalía' })).toBe('poner «Rosalía»');
  });
});

describe('OrdenesStore', () => {
  it('crea una clave, numera las órdenes y lo guarda en disco', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-ordenes-'));
    dirs.push(dir);
    const path = join(dir, 'iphone-ordenes.json');
    const a = new OrdenesStore(path);
    const clave = a.clave();
    expect(clave).toMatch(/^[a-z0-9]{8}$/);
    expect(a.crear('abrir_app', { app: 'Mail' }).id).toBe(1);
    expect(a.crear('abrir_app', { app: 'Maps' }).id).toBe(2);
    const b = new OrdenesStore(path);
    expect(b.clave()).toBe(clave);
    expect(b.pendientes().map((p) => p.id)).toEqual([1, 2]);
    expect(b.crear('abrir_app', { app: 'Fotos' }).id).toBe(3);
  });
});

describe('registrarResultado', () => {
  it('ok del atajo → «Hecho» en Telegram y deja de estar pendiente', () => {
    const s = tmpStore();
    const o = s.crear('whatsapp', { para: 'Mamá', texto: 'Llego en 10' });
    const r = registrarResultado(s, { id: o.id, ok: true });
    expect(r.telegram).toBe('✅ Hecho en el iPhone: WhatsApp a Mamá: «Llego en 10»');
    expect(s.pendientes()).toEqual([]);
    expect(registrarResultado(s, { id: o.id, ok: true }).telegram).toBeNull();
  });

  it('fallo con detalle, e id que falta', () => {
    const s = tmpStore();
    const o = s.crear('abrir_app', { app: 'Spotify' });
    expect(
      registrarResultado(s, { id: String(o.id), ok: false, detalle: 'no instalada' }).telegram,
    ).toBe('⚠️ El iPhone no ha podido: abrir Spotify (no instalada)');
    expect(registrarResultado(s, {}).status).toBe(400);
  });
});

describe('herramienta iphone_orden', () => {
  it('manda el correo con asunto y cuerpo de la orden, y dice que aún no está hecha', async () => {
    const s = tmpStore();
    const { run, enviados } = toolCon(s);
    const out = await run({ action: 'whatsapp', para: 'Mamá', texto: 'Llego en 10' });
    expect(enviados).toHaveLength(1);
    expect(enviados[0]?.to).toBe('nico@icloud.com');
    expect(enviados[0]?.subject).toBe(`ASIS-${s.clave()} whatsapp #1`);
    expect(JSON.parse(enviados[0]?.text ?? '')).toMatchObject({
      id: 1,
      accion: 'whatsapp',
      para: 'Mamá',
    });
    expect(out).toContain('Aún no está hecha');
    expect(s.pendientes()).toHaveLength(1);
  });

  it('sin correo configurado no manda nada', async () => {
    const s = tmpStore();
    const { run, enviados } = toolCon(s, { correos: async () => null });
    expect(await run({ action: 'abrir_app', app: 'Mail' })).toContain('/correo');
    expect(enviados).toEqual([]);
  });

  it('si el correo falla, no queda pendiente', async () => {
    const s = tmpStore();
    const { run } = toolCon(s, { enviar: async () => ({ ok: false, error: 'SMTP caído' }) });
    expect(await run({ action: 'recordatorio', texto: 'pan' })).toContain('SMTP caído');
    expect(s.pendientes()).toEqual([]);
  });

  it('falta un dato: lo dice y no manda', async () => {
    const s = tmpStore();
    const { run, enviados } = toolCon(s);
    expect(await run({ action: 'imessage', para: 'Ana' })).toContain('falta: texto');
    expect(enviados).toEqual([]);
  });

  it('avisa en Telegram si el iPhone no confirma a tiempo, y no si ya confirmó', async () => {
    const s = tmpStore();
    const { run, avisos } = toolCon(s, { esperaMs: 30 });
    await run({ action: 'abrir_app', app: 'Mail' });
    await run({ action: 'abrir_app', app: 'Maps' });
    registrarResultado(s, { id: 2, ok: true });
    await new Promise((r) => setTimeout(r, 80));
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain('#1');
  });

  it('estado lee: clave y pendientes', async () => {
    const s = tmpStore();
    const { run } = toolCon(s);
    await run({ action: 'musica', busqueda: 'Rosalía' });
    const out = await run({ action: 'estado' });
    expect(out).toContain(`ASIS-${s.clave()}`);
    expect(out).toContain('#1 poner «Rosalía»');
  });

  it('la Gate pregunta cada orden; estado y configurar son lectura', () => {
    const gate = new Gate();
    const c = (args: Record<string, unknown>) =>
      gate.classifyEffect({ tool: 'iphone_orden', args, actor: 'test' });
    expect(c({ action: 'whatsapp', para: 'Mamá', texto: 'hola' })).toBeNull();
    expect(c({ action: 'abrir_app', app: 'Mail' })).toBeNull();
    expect(c({ action: 'estado' })).toBe('lee');
    expect(c({ action: 'configurar' })).toBe('lee');
  });
});

describe('recetas de /atajos', () => {
  it('llevan remitente, clave, URL de resultado y las 6 acciones', () => {
    const t = recetasOrdenes({
      remitente: 'asistenta@gmail.com',
      clave: 'abc23xyz',
      urlResultado: 'https://pc.ts.net/api/atajo/resultado',
    });
    for (const s of [
      'asistenta@gmail.com',
      'ASIS-abc23xyz',
      'https://pc.ts.net/api/atajo/resultado',
      'Ejecutar inmediatamente',
    ]) {
      expect(t).toContain(s);
    }
    for (const a of ['abrir_app', 'whatsapp', 'imessage', 'recordatorio', 'evento', 'musica'])
      expect(t).toContain(a);
  });
});

describe('POST /api/atajo/resultado', () => {
  const TOKEN = 'token-orden-123';
  const recibidos: Record<string, unknown>[] = [];
  let ui: Awaited<ReturnType<typeof startWebUi>>;
  beforeAll(async () => {
    ui = await startWebUi({
      token: TOKEN,
      status: () => ({ ok: true }),
      sessions: () => [],
      memory: () => [],
      auditVerify: () => ({ ok: true }),
      atajoResultado: async (body) => {
        recibidos.push(body);
        return { status: 200, texto: 'Apuntado.' };
      },
    });
  });
  afterEach(() => {
    recibidos.length = 0;
  });
  afterAll(async () => {
    await ui.close();
  });
  const post = (body: unknown, token = TOKEN) =>
    fetch(new URL('/api/atajo/resultado', ui.url), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('pasa el cuerpo y contesta texto plano', async () => {
    const res = await post({ id: 4, ok: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('Apuntado.');
    expect(recibidos).toEqual([{ id: 4, ok: true }]);
  });

  it('sin token: 401 en una frase, sin tocar nada', async () => {
    const res = await post({ id: 4, ok: true }, 'malo');
    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/token/i);
    expect(recibidos).toEqual([]);
  });
});
