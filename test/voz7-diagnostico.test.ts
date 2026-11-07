import { afterEach, describe, expect, it } from 'vitest';
import { diagnosticoVoz, FRASE_PRUEBA, textoDiagnostico } from '../src/voice/diagnostico-voz.js';
import {
  precalentarWhisper,
  resetSttStateForTests,
  SMALL_STT_MODEL,
  setImportTransformersForTests,
} from '../src/voice/stt.js';
import { createTtsConVozLocal } from '../src/voice/voz-local.js';
import { startWebUi } from '../src/webui/server.js';
import { renderVozPage } from '../src/webui/voz-page.js';

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mp3 = (t: string) => ({ data: Buffer.from(`mp3:${t}`), mimeType: 'audio/mpeg' });

describe('/voz diagnostico: ida y vuelta de una frase con los ms de cada etapa (voz7)', () => {
  it('mide voz → oír → pensar → voz de la respuesta, en ese orden y con lo oído', async () => {
    const orden: string[] = [];
    const etapas = await diagnosticoVoz({
      speak: async (t) => {
        orden.push(`voz:${t}`);
        await espera(20);
        return mp3(t);
      },
      transcribe: async (audio) => {
        orden.push(`oir:${audio.toString()}`);
        await espera(40);
        return 'hola asistenta qué día es hoy';
      },
      pensar: async (t) => {
        orden.push(`pensar:${t}`);
        await espera(30);
        return 'Hoy es sábado.';
      },
      voz: 'supertonic-f2',
      oido: 'whisper-large-v3-turbo',
      modelo: 'kimi-k2',
    });
    expect(orden).toEqual([
      `voz:${FRASE_PRUEBA}`,
      `oir:mp3:${FRASE_PRUEBA}`,
      'pensar:hola asistenta qué día es hoy',
      'voz:Hoy es sábado.',
    ]);
    expect(etapas.map((e) => e.etapa)).toEqual(['voz', 'oir', 'pensar', 'respuesta']);
    expect(etapas.every((e) => e.ok)).toBe(true);
    expect(etapas[1]?.ms).toBeGreaterThanOrEqual(35);
    const texto = textoDiagnostico(etapas, 4);
    expect(texto).toMatch(
      /✅ Oír \(whisper\): \d+ ms — «hola asistenta qué día es hoy» · whisper-large-v3-turbo/,
    );
    expect(texto).toContain('supertonic-f2');
    expect(texto).toContain('kimi-k2');
    expect(texto).toMatch(/Total: \d+ ms · 4 núcleos/);
    expect(texto).toContain('Lo más lento: oír (whisper).');
  });

  it('una etapa que falla o se cuelga no para las demás y dice por qué', async () => {
    const etapas = await diagnosticoVoz({
      speak: async (t) => mp3(t),
      transcribe: () => new Promise<string>(() => {}),
      pensar: async () => {
        throw new Error('401 clave no válida');
      },
      topeMs: { oir: 50 },
    });
    expect(etapas.map((e) => [e.etapa, e.ok])).toEqual([
      ['voz', true],
      ['oir', false],
      ['pensar', false],
      ['respuesta', true],
    ]);
    const texto = textoDiagnostico(etapas, 4);
    expect(texto).toContain('❌ Oír (whisper)');
    expect(texto).toContain('sin terminar');
    expect(texto).toContain('401 clave no válida');
  });

  it('sin voz del PC lo dice y sigue con el modelo', async () => {
    const etapas = await diagnosticoVoz({
      speak: async () => null,
      transcribe: async () => 'x',
      pensar: async () => 'Vale.',
    });
    expect(etapas[0]?.detalle).toBe('sin audio del PC');
    expect(etapas[1]?.detalle).toBe('sin audio que oír');
    expect(etapas[2]?.ok).toBe(true);
  });

  it('la voz dice si Supertonic aún se descarga y quién habla mientras', () => {
    const tts = createTtsConVozLocal(
      { PA_TTS_LOCAL: 'supertonic-f2' },
      {
        respaldo: { name: 'sapi', speak: async () => Promise.reject(new Error('x')) },
        raiz: '/nonexistent-voz7',
        plataforma: 'win32',
      },
    );
    expect(tts.estado()).toBe('sapi (supertonic-f2 aún sin descargar)');
  });
});

describe('voz precalentada: whisper y la voz cargados antes de la primera nota (voz7)', () => {
  afterEach(() => {
    setImportTransformersForTests(null);
    resetSttStateForTests();
  });

  it('precalentarWhisper carga el modelo que usará la nota (small si el grande no está bajado)', async () => {
    const cargados: string[] = [];
    setImportTransformersForTests(
      async () =>
        ({
          LogLevel: { ERROR: 40 },
          env: {},
          pipeline: async (_t: string, m: string) => {
            cargados.push(m);
            return async () => ({ text: '' });
          },
        }) as never,
    );
    const modelo = await precalentarWhisper({ PA_STT_MODEL: 'small' });
    expect(modelo).toBe(SMALL_STT_MODEL);
    expect(cargados).toEqual([SMALL_STT_MODEL]);
  });

  it('con /voz abierta la página pide cada 2 min que no se suelte (y el PC precalienta)', async () => {
    const TOKEN = 'c'.repeat(32);
    let calentado = 0;
    const web = await startWebUi({
      token: TOKEN,
      status: () => ({}),
      sessions: () => [],
      memory: () => [],
      auditVerify: () => ({}),
      prewarm: () => {
        calentado++;
      },
    });
    try {
      const r = await fetch(`${web.url}/api/voz/calentar`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(r.status).toBe(200);
      expect(calentado).toBe(1);
      const sin = await fetch(`${web.url}/api/voz/calentar`);
      expect(sin.status).toBe(401);
    } finally {
      await web.close();
    }
    const html = renderVozPage();
    expect(html).toContain("fetch('/api/voz/calentar'");
    expect(html).toContain('}, 120000);');
  });
});
