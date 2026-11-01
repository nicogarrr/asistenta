import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const doc = readFileSync('docs/status-cli-qa.md', 'utf8');
const src = readFileSync('src/daemon-status.ts', 'utf8');

describe('docs/status-cli-qa.md describe el pa status de ahora', () => {
  it.each([
    'Para arrancarla: levantar.bat o pa iniciar.',
    'No pude comprobar si Asistenta está en marcha.',
    'Asistenta no está en marcha: se cerró sin avisar.',
  ])('la frase «%s» existe en el código y en la doc', (frase) => {
    expect(src).toContain(frase);
    expect(doc).toContain(frase);
  });

  it('no repite lo que ya no es verdad', () => {
    expect(doc).not.toMatch(
      /cablear un supervisor continuo|NO instalan vigilancia|pendientealpublicar/,
    );
    expect(doc).toMatch(/pa autostart status/);
  });
});
