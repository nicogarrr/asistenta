import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  guardarDatosIphone,
  leerDatos,
  leerLugar,
  numeroAtajo,
  paraVoz,
} from '../src/iphone/atajos.js';
import { recetasAutomatizaciones, recetasPagoYSinPc } from '../src/iphone/recetas.js';
import { atajoLugar, type LlegadaDeps, LlegadaStore } from '../src/llegada.js';
import { MemoryStore } from '../src/memory.js';
import { startWebUi, type WebUiDeps } from '../src/webui/server.js';

// Atajos del iPhone, ideas 3–6 (Nico, 7 nov: «Todo»): automatizaciones al llegar/salir de
// casa y a las 8:00, Salud y Calendario a la memoria (solo lo que él manda) y modo sin PC.

const CASA = { latitude: 43.3614, longitude: -5.8494 };
const LEJOS = { latitude: 40.4168, longitude: -3.7038 };
const CHAT = '777';
const DM = `telegram:dm:${CHAT}#main`;

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'atajos2-'));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function llegadaDeps(): LlegadaDeps {
  return {
    store: new LlegadaStore(join(tmp(), 'avisos-llegada.json')),
    home: () => CASA,
    geocode: async () => null,
  };
}

describe('LlegadaStore.evento / atajoLugar: la automatización del iPhone sin compartir ubicación', () => {
  it('al llegar a casa saltan los avisos de llegar aunque nunca se le viera fuera', async () => {
    const deps = llegadaDeps();
    deps.store.add({ chatId: CHAT, text: 'sacar la basura', place: 'casa', ...CASA, radiusM: 200 });
    deps.store.add({
      chatId: CHAT,
      text: 'coger las llaves',
      place: 'casa',
      ...CASA,
      radiusM: 200,
      modo: 'salir',
    });
    deps.store.add({ chatId: CHAT, text: 'comprar pan', place: 'Madrid', ...LEJOS, radiusM: 3000 });
    const r = await atajoLugar(deps, CHAT, 'llegar', 'casa');
    expect(r.avisos.map((a) => a.text)).toEqual(['sacar la basura']);
    expect(r.texto).toBe('Has llegado a casa. Te recuerdo: sacar la basura.');
    // El de salir queda armado (ya está dentro) y el de Madrid, intacto.
    const quedan = deps.store.list(CHAT);
    expect(quedan.map((a) => a.text).sort()).toEqual(['coger las llaves', 'comprar pan']);
    expect(quedan.find((a) => a.text === 'coger las llaves')?.armed).toBe(true);
    const s = await atajoLugar(deps, CHAT, 'salir', 'casa');
    expect(s.texto).toBe('Sales de casa. Te recuerdo: coger las llaves.');
  });

  it('sin avisos devuelve texto vacío (la automatización no enseña nada)', async () => {
    const r = await atajoLugar(llegadaDeps(), CHAT, 'llegar', 'casa');
    expect(r).toEqual({ texto: '', avisos: [] });
  });

  it('un sitio que no está guardado lo dice, no inventa coordenadas', async () => {
    const r = await atajoLugar(llegadaDeps(), CHAT, 'llegar', 'el gimnasio');
    expect(r.error).toBe(true);
    expect(r.texto).toContain('guarda esto como el gimnasio');
  });

  it('usa el sitio guardado con ese nombre', async () => {
    const deps = llegadaDeps();
    deps.store.guardarSitio(CHAT, 'el gimnasio', LEJOS);
    deps.store.add({
      chatId: CHAT,
      text: 'la toalla',
      place: 'el gimnasio',
      ...LEJOS,
      radiusM: 200,
    });
    const r = await atajoLugar(deps, CHAT, 'llegar', 'gimnasio');
    expect(r.avisos).toHaveLength(1);
    expect(r.texto).toContain('la toalla');
  });
});

describe('leerLugar / numeroAtajo / paraVoz', () => {
  it('acepta llegar/salir y casa por defecto', () => {
    expect(leerLugar({ evento: 'Llegar' })).toEqual({ evento: 'llegar', sitio: 'casa' });
    expect(leerLugar({ evento: 'salir', sitio: 'el gimnasio' })).toEqual({
      evento: 'salir',
      sitio: 'el gimnasio',
    });
    expect('error' in leerLugar({})).toBe(true);
  });
  it('lee números como los manda Atajos en español', () => {
    expect(numeroAtajo('8.432')).toBe(8432);
    expect(numeroAtajo('7,5')).toBe(7.5);
    expect(numeroAtajo(12)).toBe(12);
    expect(numeroAtajo('mucho')).toBeNull();
  });
  it('quita emojis para «Leer texto»', () => {
    expect(paraVoz('☀️ Buenos días\n📅 Hoy: dentista')).toBe('Buenos días\nHoy: dentista');
  });
});

describe('Salud y Calendario a la memoria: solo lo que Nico manda, una línea por día', () => {
  it('guarda pasos y sueño en notas/salud.md e ignora (y dice) lo que no está en la lista', () => {
    const dir = tmp();
    const m = new MemoryStore(dir, { porTema: true });
    const d = leerDatos(
      { tipo: 'salud', pasos: '8.432', sueno_horas: '7,5', frecuencia_cardiaca: 61 },
      '2026-11-07',
    );
    if ('error' in d) throw new Error(d.error);
    const r = guardarDatosIphone(m, DM, d);
    expect(r).toContain('8432 pasos; durmió 7 h 30 min');
    expect(r).toContain('No he guardado frecuencia_cardiaca');
    const file = readFileSync(join(dir, 'salud.md'), 'utf8');
    expect(file).toContain('Salud (iPhone) 2026-11-07: 8432 pasos; durmió 7 h 30 min');
    // Sin el id aleatorio de la nota («[m61b9538e]» hizo fallar esto una vez de cada ~40).
    const sinId = file.replace(/\[m[0-9a-f]+\]/g, '[id]');
    expect(sinId).not.toContain('61');
    expect(sinId).not.toMatch(/frecuencia/);
  });

  it('el mismo día otra vez corrige la línea en vez de añadir otra', () => {
    const dir = tmp();
    const m = new MemoryStore(dir, { porTema: true });
    for (const pasos of [1000, 9000]) {
      const d = leerDatos({ tipo: 'salud', pasos }, '2026-11-07');
      if ('error' in d) throw new Error(d.error);
      guardarDatosIphone(m, DM, d);
    }
    const lineas = m.all(DM).filter((e) => e.text.startsWith('Salud (iPhone) 2026-11-07'));
    expect(lineas.map((e) => e.text)).toEqual(['Salud (iPhone) 2026-11-07: 9000 pasos']);
  });

  it('el calendario va a notas/agenda.md con los eventos que manda', () => {
    const dir = tmp();
    const m = new MemoryStore(dir, { porTema: true });
    const d = leerDatos(
      {
        tipo: 'calendario',
        eventos: '10:00 · Dentista\n18:00 · Pádel\n',
        fecha: '2026-11-08T07:00:00+01:00',
      },
      '2026-11-07',
    );
    if ('error' in d) throw new Error(d.error);
    guardarDatosIphone(m, DM, d);
    expect(readFileSync(join(dir, 'agenda.md'), 'utf8')).toContain(
      'Agenda (iPhone) 2026-11-08: 10:00 · Dentista; 18:00 · Pádel',
    );
  });

  it('sin ningún dato válido no guarda nada y lo explica', () => {
    const d = leerDatos({ tipo: 'salud', pulso: 70 }, '2026-11-07');
    expect('error' in d && d.error).toContain('pasos');
    expect(
      'error' in leerDatos({ tipo: 'salud', pasos: 5, fecha: '2026-13-40' }, '2026-11-07'),
    ).toBe(true);
  });
});

describe('rutas /api/atajo/lugar, /resumen y /datos del panel', () => {
  const TOKEN = 'token-atajo-2';
  const llamadas: string[] = [];
  const deps: WebUiDeps = {
    token: TOKEN,
    status: () => ({ ok: true }),
    sessions: () => [],
    memory: () => [],
    auditVerify: () => ({ ok: true }),
    atajoLugar: async (evento, sitio) => {
      llamadas.push(`${evento}:${sitio}`);
      return evento === 'llegar' ? 'Has llegado a casa. Te recuerdo: la basura.' : '';
    },
    atajoResumen: async () => 'Buenos días. Hoy tienes dentista.',
    atajoDatos: async (body) => {
      if (body.tipo === 'rompe') throw new Error('disco');
      return `ok ${String(body.tipo)}`;
    },
  };
  let ui: Awaited<ReturnType<typeof startWebUi>>;
  beforeAll(async () => {
    ui = await startWebUi(deps);
  });
  afterAll(async () => {
    await ui.close();
  });
  const post = (path: string, body?: unknown, token: string | null = TOKEN) =>
    fetch(new URL(path, ui.url), {
      method: 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it('lugar: llama con evento y sitio y devuelve texto plano', async () => {
    const res = await post('/api/atajo/lugar', { evento: 'llegar' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('Has llegado a casa. Te recuerdo: la basura.');
    const vacio = await post('/api/atajo/lugar', { evento: 'salir', sitio: 'el gimnasio' });
    expect(await vacio.text()).toBe('');
    expect(llamadas).toEqual(['llegar:casa', 'salir:el gimnasio']);
    const malo = await post('/api/atajo/lugar', { evento: 'bailar' });
    expect(malo.status).toBe(400);
    expect(await malo.text()).toContain('llegar');
  });

  it('resumen: texto para leer, sin cuerpo', async () => {
    const res = await post('/api/atajo/resumen');
    expect(await res.text()).toBe('Buenos días. Hoy tienes dentista.');
  });

  it('datos: pasa el cuerpo y un fallo es una frase, no un error mudo', async () => {
    expect(await (await post('/api/atajo/datos', { tipo: 'salud' })).text()).toBe('ok salud');
    const roto = await post('/api/atajo/datos', { tipo: 'rompe' });
    expect(roto.status).toBe(200);
    expect(await roto.text()).toContain('Perdona');
  });

  it('sin token: 401 con una frase para leer', async () => {
    for (const path of ['/api/atajo/lugar', '/api/atajo/resumen', '/api/atajo/datos']) {
      const res = await post(path, { evento: 'llegar' }, null);
      expect(res.status).toBe(401);
      expect(res.headers.get('content-type')).toContain('text/plain');
      expect(await res.text()).toContain('/atajos');
    }
  });
});

describe('/atajos: recetas 3–6', () => {
  it('llevan la dirección real y los nombres de las acciones en español', () => {
    const t = recetasAutomatizaciones('https://pc.tail.ts.net/');
    expect(t).toContain('https://pc.tail.ts.net/api/atajo/lugar');
    expect(t).toContain('https://pc.tail.ts.net/api/atajo/resumen');
    expect(t).toContain('https://pc.tail.ts.net/api/atajo/datos');
    expect(t).toContain('Obtener contenido de URL');
    expect(t).toContain('Buscar muestras de salud');
    expect(t.length).toBeLessThan(4000);
    const p = recetasPagoYSinPc();
    expect(p).toContain('Usar modelo');
    expect(p).toContain('Pagar con Apple Pay en Safari');
    expect(p).toContain('Yo nunca pago');
    expect(p.length).toBeLessThan(4000);
  });
});
