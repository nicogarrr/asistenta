import { describe, expect, it } from 'vitest';
import {
  canonicalUrl,
  deepResearch,
  extractQuotes,
  heuristicPlan,
  keyTerms,
  parseLlmPlan,
  rankCandidates,
  renderReport,
  sanitizeCitations,
  splitSynthesis,
} from '../src/research/deep-research.js';
import type { WebSearchItem } from '../src/web/router.js';

const item = (title: string, url: string, snippet = 's'): WebSearchItem => ({
  title,
  url,
  snippet,
});

describe('plan de preguntas', () => {
  it('sin LLM el plan es la pregunta tal cual', () => {
    expect(heuristicPlan('  estado del AVE Madrid-Barcelona ')).toEqual([
      'estado del AVE Madrid-Barcelona',
    ]);
  });

  it('parsea un JSON array valido, dedup y con tope', () => {
    const raw =
      '["precio del litio 2026", "Precio del litio 2026", "minas de litio en Europa", "demanda de baterias", "reciclaje de litio", "extra"]';
    const plan = parseLlmPlan(raw, 'litio', 4);
    expect(plan).toEqual([
      'precio del litio 2026',
      'minas de litio en Europa',
      'demanda de baterias',
      'reciclaje de litio',
    ]);
  });

  it('acepta texto alrededor del array (prosa del modelo)', () => {
    const plan = parseLlmPlan('Aqui va:\n```json\n["subpregunta concreta uno"]\n```', 'tema', 4);
    expect(plan).toEqual(['subpregunta concreta uno']);
  });

  it('con basura no JSON cae al plan heuristico', () => {
    expect(parseLlmPlan('no puedo ayudarte con eso', 'pregunta original', 4)).toEqual([
      'pregunta original',
    ]);
  });

  it('descarta entradas cortas o no string', () => {
    expect(
      parseLlmPlan('["si", 42, null, "pregunta suficientemente larga"]', 'fallback', 4),
    ).toEqual(['pregunta suficientemente larga']);
  });
});

describe('terminos y citas verbatim', () => {
  it('keyTerms quita stopwords y acentos', () => {
    expect(keyTerms('¿Cuál es la previsión económica para España?')).toEqual(
      expect.arrayContaining(['prevision', 'economica', 'espana']),
    );
  });

  it('las citas son subcadenas exactas del texto leido', () => {
    const text =
      'Informe anual. El precio del litio cayo un 40 por ciento en 2025 segun el informe. ' +
      'Frase sin relacion alguna con nada. La demanda de baterias sigue creciendo en Europa.';
    const quotes = extractQuotes(text, ['litio', 'baterias'], 2);
    expect(quotes.length).toBeGreaterThan(0);
    for (const q of quotes) expect(text).toContain(q);
    expect(quotes.join(' ')).toContain('litio');
  });

  it('no devuelve citas sin terminos y respeta el maximo', () => {
    const text = 'Una frase larga sin nada que ver con los terminos buscados, de verdad.';
    expect(extractQuotes(text, ['zzz', 'yyy'], 2)).toEqual([]);
  });
});

describe('ranking de fuentes', () => {
  it('deduplica por URL canonica y ordena por puesto y repeticion', () => {
    const ranked = rankCandidates(
      [
        { query: 'a', items: [item('uno', 'https://x.es/1'), item('dos', 'https://y.es/2')] },
        { query: 'b', items: [item('uno', 'https://x.es/1/'), item('tres', 'https://z.es/3')] },
      ],
      10,
    );
    expect(ranked.map((r) => canonicalUrl(r.url))).toEqual([
      'https://x.es/1',
      'https://y.es/2',
      'https://z.es/3',
    ]);
  });

  it('aplica el tope de fuentes', () => {
    const ranked = rankCandidates(
      [
        {
          query: 'a',
          items: [item('1', 'https://a.es'), item('2', 'https://b.es'), item('3', 'https://c.es')],
        },
      ],
      2,
    );
    expect(ranked).toHaveLength(2);
  });
});

describe('sintesis', () => {
  it('separa la seccion Sin verificar', () => {
    const { synthesis, unverified } = splitSynthesis(
      'El dato es firme [1].\nSin verificar:\n- la cifra exacta de 2027\n- nada mas',
    );
    expect(synthesis).toBe('El dato es firme [1].');
    expect(unverified).toEqual(['la cifra exacta de 2027']);
  });

  it('borra citas a fuentes inexistentes', () => {
    expect(sanitizeCitations('bien [1] mal [9]', 2)).toBe('bien [1] mal ');
  });
});

describe('deepResearch end to end (deps falsas)', () => {
  const PAGE =
    'Estudio sobre el tren. El AVE Madrid Barcelona bajo su precio un 15 por ciento en 2026. ' +
    'Otra frase de relleno sin interes. La ocupacion media subio al 90 por ciento.';

  const deps = {
    search: async () => [
      item('Renfe nota', 'https://renfe.es/nota'),
      item('Prensa', 'https://press.es/ave'),
    ],
    fetch: async (url: string) => (url.includes('renfe') ? PAGE : PAGE),
  };

  it('modo determinista: informe de citas verbatim con fuentes', async () => {
    const r = await deepResearch('precio del AVE Madrid Barcelona', deps);
    expect(r.usedLlm).toBe(false);
    expect(r.plan).toEqual(['precio del AVE Madrid Barcelona']);
    expect(r.sources.length).toBeGreaterThan(0);
    expect(r.synthesis).toContain('Hallazgos textuales');
    for (const s of r.sources) for (const q of s.quotes) expect(PAGE).toContain(q);
    const text = renderReport(r);
    expect(text).toContain('Investigacion: precio del AVE Madrid Barcelona');
    expect(text).toContain('Fuentes (');
  });

  it('con LLM: plan parseado, sintesis saneada y seccion sin verificar', async () => {
    const calls: string[] = [];
    const r = await deepResearch('precio del AVE', {
      ...deps,
      llm: async (system) => {
        calls.push(system);
        return system.includes('planificador')
          ? '["precio AVE 2026", "ocupacion del AVE"]'
          : 'El precio bajo [1]. La ocupacion subio [2] y algo inventado [7].\nSin verificar:\n- el motivo de la bajada';
      },
    });
    expect(r.usedLlm).toBe(true);
    expect(r.plan).toEqual(['precio AVE 2026', 'ocupacion del AVE']);
    expect(r.synthesis).toContain('[1]');
    expect(r.synthesis).not.toContain('[7]');
    expect(r.unverified).toContain('el motivo de la bajada');
  });

  it('si el LLM falla en plan y sintesis, degrada y lo marca sin verificar', async () => {
    const r = await deepResearch('precio del AVE', {
      ...deps,
      llm: async () => {
        throw new Error('cuota agotada');
      },
    });
    expect(r.usedLlm).toBe(false);
    expect(r.unverified.some((u) => u.includes('plan'))).toBe(true);
    expect(r.unverified.some((u) => u.includes('sintesis'))).toBe(true);
  });

  it('marca busquedas y lecturas fallidas sin tumbar el informe', async () => {
    const r = await deepResearch('precio del AVE', {
      search: async (q) => {
        if (q === 'precio del AVE') throw new Error('429');
        return [item('ok', 'https://ok.es')];
      },
      fetch: async () => PAGE,
      llm: async () => '["precio del AVE", "ocupacion"]',
    });
    expect(r.unverified.some((u) => u.includes('La busqueda fallo'))).toBe(true);
    expect(r.sources.length).toBeGreaterThan(0);
  });

  it('sin ninguna fuente legible, error claro', async () => {
    await expect(
      deepResearch('tema', {
        search: async () => [item('x', 'https://x.es')],
        fetch: async () => {
          throw new Error('vacio');
        },
      }),
    ).rejects.toThrow('ninguna fuente legible');
  });

  it('sin pregunta, error de uso', async () => {
    await expect(deepResearch('   ', deps)).rejects.toThrow('Falta la pregunta');
  });
});

describe('renderReport', () => {
  it('recorta informes largos en un salto de linea', async () => {
    const longPage = `Dato clave sobre el tema concreto y medido con detalle. ${'x'.repeat(500)}`;
    const r = await deepResearch('tema', {
      search: async () => Array.from({ length: 6 }, (_, i) => item(`t${i}`, `https://t${i}.es`)),
      fetch: async () => longPage,
      maxSources: 6,
    });
    const text = renderReport(r, 600);
    expect(text.length).toBeLessThanOrEqual(650);
    expect(text).toContain('(informe recortado)');
  });
});
