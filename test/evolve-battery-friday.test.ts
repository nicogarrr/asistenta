import { describe, expect, it } from 'vitest';
import {
  type BatteryCase,
  fridayCandidates,
  judge,
  type Trace,
} from '../src/evolve/battery-judge.js';

// «el viernes de la semana que viene»: si la respuesta pregunta («¿cuál…?») no se exige la
// fecha. Pero «cual» se buscaba como trozo de palabra: «actual», «cualquier» o «puntual»
// contaban como preguntar, y una fecha equivocada pasaba.

const c: BatteryCase = {
  id: 'B-vie',
  prompt: 'apúntame el viernes de la semana que viene',
  machine: { dynamicDate: 'nextFriday' },
};
const now = new Date('2026-11-04T10:00:00Z'); // miércoles 4 de noviembre
const v = (reply: string) => {
  const t: Trace = { reply, toolCalls: [], approvalsAsked: 0 };
  return judge(c, t, now).verdict;
};

describe('batería: «viernes» solo exime de la fecha si de verdad pregunta', () => {
  it('una palabra que contiene «cual» no es una pregunta', () => {
    expect(v('Apuntado para el viernes 20 de noviembre, cualquier cosa me dices.')).toBe('fail');
    expect(v('Según tu agenda actual, el viernes 20 de noviembre está libre.')).toBe('fail');
  });
  it('preguntar sigue valiendo, y la fecha buena también', () => {
    expect(v('¿Cuál viernes: el 6 o el 13 de noviembre?')).toBe('pass');
    const [a] = fridayCandidates(now) as [{ day: number; month: string }];
    expect(v(`Hecho, el viernes ${a.day} de ${a.month}.`)).toBe('pass');
  });
});
