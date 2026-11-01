import { describe, expect, it } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';

const cron = (s: string) => parseNatural(s)?.schedule ?? null;

describe('rutinas: fechas del año y periodos que no son «cada día»', () => {
  it('«cada 25 de diciembre» es una vez al año, no todos los días', () => {
    expect(cron('cada 25 de diciembre a las 9 felicita a la familia')).toBe('0 9 25 12 *');
    expect(cron('todos los años el 6 de enero a las 9 reyes')).toBe('0 9 6 1 *');
    expect(cron('anualmente el 1 de enero a las 10 revisa el seguro')).toBe('0 10 1 1 *');
    expect(cron('cada 1 de enero el resumen del año')).toBe('0 8 1 1 *');
  });

  it('una fecha que no existe, o una fecha suelta sin «cada año», se pregunta', () => {
    expect(cron('cada 31 de febrero a las 9 x')).toBeNull();
    expect(cron('el 6 de enero a las 9 avísame de los reyes')).toBeNull();
  });

  it('cada año, cada quincena, cada trimestre o una vez al mes sin día se preguntan', () => {
    expect(cron('cada año a las 9 revisa el seguro')).toBeNull();
    expect(cron('una vez al mes a las 9 paga el alquiler')).toBeNull();
    expect(cron('cada quincena a las 9 riega')).toBeNull();
    expect(cron('cada trimestre a las 9 el IVA')).toBeNull();
  });

  it('«cada día 5» es el día 5 de cada mes', () => {
    expect(cron('cada día 5 a las 9 paga el alquiler')).toBe('0 9 5 * *');
  });

  it('lo que ya funcionaba no cambia', () => {
    expect(cron('todos los días a las 9 recuérdame que el 6 de enero es reyes')).toBe('0 9 * * *');
    expect(cron('cada lunes a las 9 x')).toBe('0 9 * * 1');
    expect(cron('el día 5 de cada mes a las 9 x')).toBe('0 9 5 * *');
    expect(cron('cada día a las 8 x')).toBe('0 8 * * *');
    expect(cron('cada lunes a las 9 cuenta los días hasta el 25 de diciembre')).toBe('0 9 * * 1');
    expect(cron('cada lunes a las 9 revisa el informe anual')).toBe('0 9 * * 1');
  });
});
