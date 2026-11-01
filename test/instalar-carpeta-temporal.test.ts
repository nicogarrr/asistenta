import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error TS7016: módulo .mjs ejecutable, sin declaración de tipos.
import { enCarpetaTemporal, instalar } from '../scripts/instalar.mjs';

// Abrir instalar.bat «desde dentro» del ZIP con WinRAR o con el Explorador puede
// sacar todo a una carpeta temporal (…\Temp\Rar$EXa…, …\Temp\Temp1_x.zip\…). El
// instalador seguía y lo instalaba allí; al cerrar el ZIP Windows lo borra y
// levantar.bat ya no existe. Ahora para antes y explica que hay que extraerlo.
const TEMP = 'C:\\Users\\Nico\\AppData\\Local\\Temp';

function deps(over: Record<string, unknown> = {}) {
  const out: string[] = [];
  const d = {
    nodeVersion: 'v24.3.0',
    cwd: 'C:\\Asistenta',
    env: { TEMP, TMP: TEMP },
    write: (s: string) => out.push(s),
    run: vi.fn(async () => 0),
    exists: () => false,
    copy: vi.fn(),
    readEnv: () => '',
    cli: vi.fn(async () => 1),
    vaultList: async () => null,
    vaultSet: vi.fn(async () => 0),
    ask: vi.fn(async () => ''),
    fetch: vi.fn(),
    ...over,
  };
  return { d, text: () => out.join('') };
}

describe('enCarpetaTemporal', () => {
  it('reconoce las carpetas donde se abre un ZIP sin extraer', () => {
    const env = { TEMP };
    expect(enCarpetaTemporal(`${TEMP}\\Rar$EXa1234.5678\\asistenta-main`, env)).toBe(true);
    expect(enCarpetaTemporal(`${TEMP}\\Temp1_asistenta-main.zip\\asistenta-main`, env)).toBe(true);
    expect(enCarpetaTemporal(`${TEMP}\\7zO8A1B\\asistenta-main`, env)).toBe(true);
    // Sin la variable TEMP también (ruta típica de Windows).
    expect(enCarpetaTemporal(`${TEMP}\\Temp1_asistenta.zip\\asistenta`, {})).toBe(true);
  });

  it('no salta con carpetas normales', () => {
    const env = { TEMP };
    expect(enCarpetaTemporal('C:\\Asistenta', env)).toBe(false);
    expect(enCarpetaTemporal('C:\\Users\\Nico\\Desktop\\temporal\\asistenta', env)).toBe(false);
    expect(
      enCarpetaTemporal('C:\\Users\\Nico\\Downloads\\asistenta-main (1)\\asistenta-main', env),
    ).toBe(false);
    // En Linux /tmp no cuenta (los tests y quien lo prueba ahí).
    expect(enCarpetaTemporal('/tmp/asistenta', { TMP: '/tmp', TEMP: '/tmp' })).toBe(false);
  });
});

describe('instalar dentro de una carpeta temporal', () => {
  it('para antes de instalar y dice que extraiga el ZIP', async () => {
    const { d, text } = deps({ cwd: `${TEMP}\\Rar$EXa1234.5678\\asistenta-main` });
    expect(await instalar(d)).toBe(1);
    expect(d.run).not.toHaveBeenCalled();
    expect(text()).toContain('Extraer todo');
    expect(text()).toContain('C:\\Asistenta');
  });

  it('en una carpeta normal sigue', async () => {
    const { d } = deps();
    await instalar(d);
    expect(d.run).toHaveBeenCalled();
  });
});
