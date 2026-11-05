import { describe, expect, it } from 'vitest';
import {
  HELP_PAGE_CHARS,
  HELP_SECTIONS,
  type HelpSection,
  helpPages,
  helpReply,
} from '../src/channels/telegram-help.js';

/**
 * /help era un solo mensaje y estaba a 3987 de 4000 caracteres: /latido, /temas o /expertos ya
 * no cabían. Ahora va por páginas («/help 2», «/help más») y «/help vigila» busca.
 */
describe('/help por páginas', () => {
  it('cada página cabe en un mensaje y cada sección sale una vez, en orden', () => {
    const pages = helpPages({ bold: true });
    for (const page of pages)
      expect(Array.from(page).length).toBeLessThanOrEqual(HELP_PAGE_CHARS + 60);
    const all = pages.join('\n\n');
    let at = -1;
    for (const s of HELP_SECTIONS) {
      const i = all.indexOf(`**${s.title}**`);
      expect(i, s.title).toBeGreaterThan(at);
      expect(all.indexOf(`**${s.title}**`, i + 1), s.title).toBe(-1);
      at = i;
    }
  });

  it('las páginas que no son la última dicen cómo seguir', () => {
    const pages = helpPages();
    expect(pages.length).toBeGreaterThan(1);
    for (const [i, p] of pages.slice(0, -1).entries()) {
      expect(p.endsWith(`/help ${i + 2}`)).toBe(true);
    }
    expect(pages[pages.length - 1]).not.toContain('Más comandos');
    expect(pages[1]?.startsWith(`Ayuda (2/${pages.length})`)).toBe(true);
  });

  it('con una sección más grande que crece, sigue cabiendo (hay sitio para comandos nuevos)', () => {
    const extra: HelpSection = {
      title: '🧪 Prueba',
      entries: Array.from({ length: 40 }, (_, i) => ({
        command: `nuevo${i}`,
        description: 'un comando nuevo con su descripción de longitud normal',
      })),
    };
    HELP_SECTIONS.push(extra);
    try {
      for (const page of helpPages({ bold: true }))
        expect(Array.from(page).length).toBeLessThan(4000);
      expect(helpPages().join('\n')).toContain('/nuevo39');
    } finally {
      HELP_SECTIONS.pop();
    }
  });

  it('«/help», «/help 2», «/help más», «/help 99»', () => {
    const pages = helpPages();
    expect(helpReply('')).toBe(pages[0]);
    expect(helpReply('2')).toBe(pages[1]);
    expect(helpReply('más')).toBe(pages[1]);
    expect(helpReply('mas')).toBe(pages[1]);
    expect(helpReply('99')).toBe(pages[pages.length - 1]);
  });

  it('«/help recordatorio» busca los comandos que hablan de eso, con su sección', () => {
    const got = helpReply('calendario');
    expect(got).toContain('/calendario');
    expect(got.split('\n').some((l) => HELP_SECTIONS.some((s) => s.title === l))).toBe(true);
    expect(Array.from(got).length).toBeLessThan(Array.from(helpPages()[0] as string).length);
  });

  it('una palabra que no está lo dice y apunta a /funciones', () => {
    expect(helpReply('zzzz')).toContain('No tengo comandos con «zzzz»');
    expect(helpReply('zzzz')).toContain('/funciones');
  });
});
