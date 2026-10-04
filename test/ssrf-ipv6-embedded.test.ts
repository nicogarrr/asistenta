import { describe, expect, it } from 'vitest';
import { isFetchable, isPublicIp } from '../src/tools/fetch.js';

describe('IPv6 con IPv4 privada embebida y 100.64/10', () => {
  it('bloquea las formas IPv6 que llevan una IPv4 privada', () => {
    for (const ip of [
      '::7f00:1',
      '::127.0.0.1',
      '::a00:1',
      '64:ff9b::7f00:1',
      '64:ff9b::10.0.0.1',
      '2002:7f00:1::1',
      '2002:a9fe:a9fe::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
  });

  it('permite las formas IPv6 con IPv4 publica', () => {
    for (const ip of ['::808:808', '64:ff9b::808:808', '2002:808:808::1', '2606:4700:4700::1111']) {
      expect(isPublicIp(ip), ip).toBe(true);
    }
  });

  it('el filtro lexico de 100.64/10 no bloquea 100.128+ (publicas)', () => {
    expect(isFetchable('http://100.64.0.1/')).toBe(false);
    expect(isFetchable('http://100.127.255.255/')).toBe(false);
    expect(isFetchable('http://100.128.0.1/')).toBe(true);
    expect(isFetchable('http://100.200.1.1/')).toBe(true);
  });
});
