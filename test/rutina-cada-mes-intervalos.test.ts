import { describe, expect, it } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';

// gertru-gaps-7: «cada mes el día 5 a las 10» y «cada 2 días a las 9» quedaban CADA DÍA;
// «cada dos horas» o «cada media hora» no se entendían.
describe('rutinas: cada mes, cada N días e intervalos dichos en palabras', () => {
  const at = (text: string) => parseNatural(text)?.schedule ?? null;

  it('un día del mes', () => {
    expect(at('cada mes el día 5 a las 10 paga el alquiler')).toBe('0 10 5 * *');
    expect(at('el día 1 de cada mes a las 9 revisa la factura')).toBe('0 9 1 * *');
    expect(at('el primer día de cada mes paga la cuota')).toBe('0 8 1 * *');
    expect(at('todos los meses el 15 a las 20:30 mira el recibo')).toBe('30 20 15 * *');
  });

  it('lo que un cron no dice simple ya no se guarda como «cada día»: pregunta', () => {
    expect(at('cada 2 días a las 9 riega')).toBeNull();
    expect(at('cada dos semanas a las 10 limpia el filtro')).toBeNull();
    expect(at('el último día de cada mes a las 9 cierra caja')).toBeNull();
    expect(at('cada mes a las 9 paga')).toBeNull();
    expect(at('cada mes paga 20 euros')).toBeNull();
  });

  it('intervalos en palabras', () => {
    expect(at('cada dos horas bebe agua')).toBe('0 */2 * * *');
    expect(at('cada quince minutos estira')).toBe('*/15 * * * *');
    expect(at('cada media hora bebe agua')).toBe('*/30 * * * *');
    expect(at('cada cuarto de hora mira el horno')).toBe('*/15 * * * *');
    expect(at('cada 30 min mira la cola')).toBe('*/30 * * * *');
    expect(at('cada 5 minutos comprueba')).toBe('*/5 * * * *');
  });

  it('lo de siempre no cambia', () => {
    expect(at('cada día a las 9 pastilla')).toBe('0 9 * * *');
    expect(at('cada semana a las 9 resumen')).toBe('0 9 * * 1');
    expect(at('cada hora comprueba')).toBe('0 * * * *');
  });
});
