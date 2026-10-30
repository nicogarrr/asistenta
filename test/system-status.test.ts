import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ answers: [] as Array<string | Error>, calls: [] as string[] }));
vi.mock('node:child_process', () => ({
  execFile: (
    _file: string,
    args: string[],
    _opts: unknown,
    cb: (error: Error | null, out: string, err: string) => void,
  ) => {
    mock.calls.push(args.at(-1) ?? '');
    const answer = mock.answers.shift();
    if (answer instanceof Error) cb(answer, '', '');
    else if (answer === undefined) cb(new Error('unexpected process'), '', '');
    else cb(null, answer, '');
  },
}));
vi.mock('node:util', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:util')>();
  return {
    ...original,
    promisify:
      (fn: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) =>
        new Promise((resolve, reject) =>
          fn(...args, (err: Error | null, out: string) =>
            err ? reject(err) : resolve({ stdout: out }),
          ),
        ),
  };
});

import { createSystemTool, setVolume, systemStatus } from '../src/tools/system.js';

beforeEach(() => {
  mock.answers = [];
  mock.calls = [];
});

const status = (battery: string, batteryStatus: string, net = '1|192.168.1.20') =>
  [`B|${battery}`, `P|${batteryStatus}`, 'D|120.5|476.3', 'R|7.25|15.86', `N|${net}`].join('\r\n');

describe('systemStatus: Win32_Battery.BatteryStatus', () => {
  // Documentación de Win32_Battery: 1 = descargándose (con batería), 2 = con corriente
  // alterna (no se descarga). Antes se leía al revés: «2» era «con batería».
  it('1 = descargándose: está con batería', async () => {
    mock.answers = [status('55', '1')];
    expect((await systemStatus()).onBattery).toBe(true);
  });

  it('2 = enchufado a la corriente: NO está con batería', async () => {
    mock.answers = [status('80', '2')];
    expect((await systemStatus()).onBattery).toBe(false);
  });

  it('cargando (6-9) y carga completa (3) son enchufado; baja (4) y crítica (5) son batería', async () => {
    for (const [code, onBattery] of [
      ['3', false],
      ['6', false],
      ['7', false],
      ['4', true],
      ['5', true],
    ] as const) {
      mock.answers = [status('20', code)];
      expect((await systemStatus()).onBattery, `BatteryStatus ${code}`).toBe(onBattery);
    }
  });

  it('el texto de la tool dice «(enchufado)» solo cuando lo está', async () => {
    const tool = createSystemTool();
    mock.answers = [status('80', '2')];
    const plugged = await tool.execute('1', { action: 'status' });
    expect(JSON.stringify(plugged.content)).toContain('Bateria 80% (enchufado)');
    mock.answers = [status('55', '1')];
    const unplugged = await tool.execute('2', { action: 'status' });
    const text = JSON.stringify(unplugged.content);
    expect(text).toContain('Bateria 55%');
    expect(text).not.toContain('enchufado');
  });

  it('lee disco, RAM y red; un sobremesa sin batería lo dice', async () => {
    mock.answers = [status('x', 'x', '0|x')];
    const s = await systemStatus();
    expect(s).toMatchObject({
      batteryPercent: null,
      onBattery: false,
      diskFreeGb: 120.5,
      diskTotalGb: 476.3,
      ramUsedGb: 7.25,
      ramTotalGb: 15.86,
      online: false,
      localIp: null,
    });
    const tool = createSystemTool();
    mock.answers = [status('x', 'x', '0|x')];
    const text = JSON.stringify((await tool.execute('3', { action: 'status' })).content);
    expect(text).toContain('Sin bateria');
    expect(text).toContain('SIN CONEXION');
  });

  it('si PowerShell falla, devuelve ceros en vez de romper la respuesta', async () => {
    mock.answers = [new Error('powershell no está')];
    const s = await systemStatus();
    expect(s).toMatchObject({ batteryPercent: null, diskFreeGb: 0, ramTotalGb: 0, online: false });
  });
});

describe('setVolume: límites', () => {
  it('recorta por arriba y por abajo antes de escribir el nivel', async () => {
    mock.answers = ['set hr=0', '100|0'];
    expect((await setVolume(150)).level).toBe(100);
    expect(mock.calls[0]).toContain('$raw = [uint32]65535');
    mock.calls = [];
    mock.answers = ['set hr=0', '0|1'];
    expect((await setVolume(-5)).level).toBe(0);
    expect(mock.calls[0]).toContain('$raw = [uint32]0');
  });

  it('el porcentaje sobrevive a la ida y vuelta a la escala 0-65535 en todo el rango', () => {
    for (let v = 0; v <= 100; v++) {
      const raw = Math.round((v / 100) * 65535);
      expect(Math.round((raw / 65535) * 100)).toBe(v);
    }
  });
});

describe('tool system: errores claros', () => {
  it('play sin fichero pide la ruta', async () => {
    await expect(createSystemTool().execute('1', { action: 'play' })).rejects.toThrow(/path/);
  });
});

describe('setVolume: aviso cuando el dispositivo no aplica el nivel', () => {
  it('avisa si la lectura de vuelta no coincide (antes nunca saltaba) y no avisa por redondeo', async () => {
    const { log } = await import('../src/log.js');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      mock.calls = [];
      mock.answers = ['set hr=0', '30|0'];
      expect((await setVolume(70)).level).toBe(30);
      expect(warn).toHaveBeenCalledWith(
        'volume set did not take',
        expect.objectContaining({ wanted: 70, got: 30 }),
      );
      warn.mockClear();
      mock.answers = ['set hr=0', '69|0'];
      await setVolume(70);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
