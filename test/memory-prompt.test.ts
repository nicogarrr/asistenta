/**
 * Seccion de memoria del prompt: perfil v2 y memoria del chat en bloques
 * separados, con tope propio y sin lanzar nunca. El perfil legado no se
 * duplica: `<perfil>` solo pinta hechos vigentes y `<memory>` es el cuerpo ya
 * renderizado del indice, no otra copia del perfil.
 */
import { describe, expect, it } from 'vitest';
import {
  buildMemoryPromptSection,
  MEMORY_PROMPT_BLOCK_CAP,
  type PromptProfile,
} from '../src/memory/prompt.js';

const LIVE = { supersededBy: null };
const OLD = { supersededBy: 'otro' };

function profile(facts: Array<{ supersededBy: string | null }>, rendered: string): PromptProfile {
  return { load: () => facts, render: () => rendered };
}

function block(section: string, tag: 'perfil' | 'memory'): string | undefined {
  return section.match(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`))?.[0];
}

describe('buildMemoryPromptSection', () => {
  it('sin perfil ni memoria devuelve cadena vacia', () => {
    expect(buildMemoryPromptSection({})).toBe('');
    expect(buildMemoryPromptSection({ profile: profile([], ''), memoryBody: '   ' })).toBe('');
  });

  it('pinta <perfil> solo cuando hay hechos vigentes', () => {
    const section = buildMemoryPromptSection({
      profile: profile([LIVE], '- [p1] (2026-10-01) vive en Madrid'),
    });
    expect(section).toBe('<perfil>\n- [p1] (2026-10-01) vive en Madrid\n</perfil>');
    expect(section).not.toContain('<memory>');
  });

  it('un perfil con todos los hechos sustituidos no gasta tokens', () => {
    const section = buildMemoryPromptSection({
      profile: profile([OLD, OLD], '- [p1] (2026-10-01) dato viejo'),
    });
    expect(section).toBe('');
  });

  it('si render devuelve vacio no aparece el bloque aunque haya un hecho vigente', () => {
    expect(buildMemoryPromptSection({ profile: profile([LIVE], '   ') })).toBe('');
  });

  it('pinta <memory> con el cuerpo ya renderizado, sin anadir perfil', () => {
    const section = buildMemoryPromptSection({ memoryBody: 'Memoria del chat: 2 activas' });
    expect(section).toBe('<memory>\nMemoria del chat: 2 activas\n</memory>');
    expect(section).not.toContain('<perfil>');
  });

  it('separa perfil y memoria con una linea en blanco y no duplica etiquetas', () => {
    const section = buildMemoryPromptSection({
      profile: profile([LIVE], '- [p1] (2026-10-01) le gusta el cafe'),
      memoryBody: '- [m1] (2026-10-02) prefiere respuestas cortas',
    });
    expect(section).toBe(
      [
        '<perfil>',
        '- [p1] (2026-10-01) le gusta el cafe',
        '</perfil>',
        '',
        '<memory>',
        '- [m1] (2026-10-02) prefiere respuestas cortas',
        '</memory>',
      ].join('\n'),
    );
    expect(section.match(/<perfil>/g)).toHaveLength(1);
    expect(section.match(/<memory>/g)).toHaveLength(1);
  });

  it('recorta cada bloque completo a MEMORY_PROMPT_BLOCK_CAP, por separado', () => {
    const section = buildMemoryPromptSection({
      profile: profile([LIVE], `perfil ${'p'.repeat(8_000)}`),
      memoryBody: `memoria ${'m'.repeat(8_000)}`,
    });
    const perfil = block(section, 'perfil') ?? '';
    const memory = block(section, 'memory') ?? '';
    expect(perfil.length).toBeLessThanOrEqual(MEMORY_PROMPT_BLOCK_CAP);
    expect(memory.length).toBeLessThanOrEqual(MEMORY_PROMPT_BLOCK_CAP);
    expect(perfil).toContain('perfil p');
    expect(memory).toContain('memoria m');
    // El recorte se anuncia y nunca parte la etiqueta de cierre.
    expect(perfil.endsWith('…\n</perfil>')).toBe(true);
    expect(memory.endsWith('…\n</memory>')).toBe(true);
  });

  it('NUNCA lanza: load o render rotos devuelven cadena vacia', () => {
    const loadThrows: PromptProfile = {
      load: () => {
        throw new Error('json roto');
      },
      render: () => 'x',
    };
    const renderThrows: PromptProfile = {
      load: () => [LIVE],
      render: () => {
        throw new Error('render roto');
      },
    };
    expect(buildMemoryPromptSection({ profile: loadThrows })).toBe('');
    expect(buildMemoryPromptSection({ profile: renderThrows })).toBe('');
    // Un cuerpo que no es string (dato venido de otro modulo) tampoco rompe.
    expect(
      buildMemoryPromptSection({ memoryBody: 42 as unknown as string, profile: undefined }),
    ).toBe('');
  });
});
