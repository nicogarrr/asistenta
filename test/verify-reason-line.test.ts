import { describe, expect, it } from 'vitest';
import { firstRealLine } from '../src/screen/verify.js';

/**
 * Motivo de un fallo de comparación de capturas. Con un error de sintaxis
 * PowerShell imprime primero «At line…» y la línea del script citada con «+»,
 * y el mensaje va DESPUÉS: el motivo salía como «+ $bmp = …» (un trozo del script).
 */
describe('verify · firstRealLine', () => {
  it('error de sintaxis: el mensaje, no la línea del script citada', () => {
    const stderr = [
      'At line:3 char:5',
      '+ if ($bmp -eq',
      '+     ~',
      "Missing '(' after 'if' in if statement.",
      '    + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordException',
      '    + FullyQualifiedErrorId : NoOpenParenthesisAfterIf',
    ].join('\r\n');
    expect(firstRealLine(stderr)).toBe("Missing '(' after 'if' in if statement.");
  });

  it('en español igual', () => {
    const stderr =
      'En línea: 2 Carácter: 1\n+ $x = [Foo]::Bar()\n+ ~~~~\nNo se encuentra el tipo [Foo].';
    expect(firstRealLine(stderr)).toBe('No se encuentra el tipo [Foo].');
  });

  it('error normal: el mensaje de la primera línea (caracterización)', () => {
    const stderr =
      'Exception calling "FromFile" with "1" argument(s): "Out of memory."\nAt line:9 char:1\n+ $a = [Drawing.Image]::FromFile($p)\n+ ~~~~\n    + CategoryInfo : NotSpecified';
    expect(firstRealLine(stderr)).toBe(
      'Exception calling "FromFile" with "1" argument(s): "Out of memory."',
    );
  });

  it('solo mobiliario o vacío: null', () => {
    expect(firstRealLine('')).toBeNull();
    expect(firstRealLine('At line:1 char:1\n+ x\n+ ~')).toBeNull();
  });
});
