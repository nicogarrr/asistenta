import { describe, expect, it } from 'vitest';
import { macFromNetworkInfo } from '../src/tv/tv-cli.js';

describe('pa tv setup: la MAC leída de la tele pasa la misma validación que `pa tv mac`', () => {
  it('una MAC multicast en el cable (ID de app, no de tarjeta) se salta y se usa la de wifi', () => {
    expect(
      macFromNetworkInfo({
        wiredInfo: { macAddress: '69:e3:ed:6b:a4:4b' },
        wifiInfo: { macAddress: 'a8:23:fe:01:02:03' },
      }),
    ).toBe('a8:23:fe:01:02:03');
  });
  it('multicast, todo ceros o broadcast en las dos → null (no se guarda nada)', () => {
    expect(
      macFromNetworkInfo({
        wiredInfo: { macAddress: '01:00:5e:00:00:01' },
        wifiInfo: { macAddress: '00:00:00:00:00:00' },
      }),
    ).toBeNull();
    expect(macFromNetworkInfo({ wiredInfo: { macAddress: 'ff:ff:ff:ff:ff:ff' } })).toBeNull();
  });
  it('una MAC normal de cable se sigue usando primero', () => {
    expect(
      macFromNetworkInfo({
        wiredInfo: { macAddress: '64:95:6C:AA:BB:CC' },
        wifiInfo: { macAddress: 'a8:23:fe:01:02:03' },
      }),
    ).toBe('64:95:6c:aa:bb:cc');
  });
});
