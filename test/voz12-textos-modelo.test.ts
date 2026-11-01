import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Nico (1 nov): que Asistenta hable como un amigo. Los textos que el modelo lee (y
// suele repetir tal cual) tampoco mandan a comandos.
const read = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');

describe('textos para el modelo sin comandos', () => {
  it('vista en directo, macros y grabación de pantalla', () => {
    const media = read('tools/media.ts');
    expect(media).not.toContain('usa /screen live o /camera on');
    expect(media).toContain('solo va en el chat de Telegram.');
    const gestion = read('tools/gestion.ts');
    expect(gestion).not.toMatch(/(las ves|sees them) con? \/routines|with \/routines/);
    expect(gestion).toContain("'macro necesita el nombre con su namespace: macro/<nombre>.'");
    const rec = read('screen/recorder.ts');
    expect(rec).not.toContain('Usa /screen');
    expect(rec).toContain('Una captura puntual sí te la puedo mandar.');
  });
});
