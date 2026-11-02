import { describe, expect, it } from 'vitest';
import { ensureActiveTv, matchKnownTv, tvPort } from '../src/tv/auto-select.js';
import { braviaValidateMethods, sonyModelYear, sonyModelYearText } from '../src/tv/bravia.js';
import type { DiscoveredTv } from '../src/tv/discover.js';
import type { KnownTv } from '../src/tv/registry.js';

const lgTv: KnownTv = {
  host: '192.168.1.20',
  brand: 'lg',
  name: 'Salon',
  clientKey: 'clave-lg',
  secure: '1',
  mac: 'AA:BB:CC:DD:EE:01',
  uuid: 'uuid-lg-1',
};
const sonyTv: KnownTv = {
  host: '10.0.0.9',
  brand: 'sony',
  name: 'Dormitorio',
  model: 'XR-55X90J',
  clientKey: '',
  secure: '1',
  mac: 'AA:BB:CC:DD:EE:02',
  uuid: 'uuid-sony-1',
};
const found = (ip: string, brand: 'lg' | 'sony', uuid: string): DiscoveredTv => ({
  ip,
  brand,
  uuid,
  usn: `uuid:${uuid}::upnp:rootdevice`,
  glasshouse: false,
});

describe('matchKnownTv', () => {
  const known = [lgTv, sonyTv];

  it('reconoce por IP exacta aunque no haya uuid', () => {
    const f = found('192.168.1.20', 'lg', 'uuid-otra');
    expect(matchKnownTv(f, known, null)?.name).toBe('Salon');
  });

  it('reconoce por uuid SSDP cuando el DHCP le cambio la IP', () => {
    const f = found('192.168.50.40', 'lg', 'uuid-lg-1');
    expect(matchKnownTv(f, known, null)?.name).toBe('Salon');
  });

  it('reconoce por MAC cuando ni IP ni uuid coinciden', () => {
    const f = found('192.168.50.99', 'sony', 'uuid-desconocido');
    expect(matchKnownTv(f, known, 'aa-bb-cc-dd-ee-02')?.name).toBe('Dormitorio');
  });

  it('sin IP, uuid ni MAC conocidos no casa con nada', () => {
    const f = found('192.168.50.1', 'lg', 'uuid-vecino');
    expect(matchKnownTv(f, known, 'aa-bb-cc-dd-ee-99')).toBeUndefined();
    expect(matchKnownTv(f, known, 'no-es-una-mac')).toBeUndefined();
  });
});

describe('tvPort', () => {
  it('Sony delata por el 80 (REST) y LG por el 3001 (SSAP cifrado)', () => {
    expect(tvPort('sony')).toBe(80);
    expect(tvPort('lg')).toBe(3001);
  });
});

describe('sonyModelYear(Text)', () => {
  it('la letra final da el año de la gama (J=2021, H=2020, C=2015)', () => {
    expect(sonyModelYear('XR-55X90J')).toBe(2021);
    expect(sonyModelYear('XBR-55A8H')).toBe(2020);
    expect(sonyModelYear('KDL-40W605C')).toBe(2015);
  });

  it('modelo acabado en número o irreconocible no tiene año estimado', () => {
    expect(sonyModelYear('KD-55XH9096')).toBeUndefined();
    expect(sonyModelYear('')).toBeUndefined();
    expect(sonyModelYearText('KD-55XH9096')).toBe('año por confirmar');
    expect(sonyModelYearText('XR-55X90J')).toBe('2021 aprox.');
  });
});

describe('braviaValidateMethods (fetch falso)', () => {
  const okAll = (async (url: string) => {
    const service = String(url).split('/').pop();
    const body =
      service === 'audio'
        ? { result: [[{ target: 'speaker', volume: 10, mute: false, maxVolume: 100 }]], id: 1 }
        : { result: [{ status: 'active', name: 'BRAVIA', model: 'XR-55X90J' }], id: 1 };
    return new Response(JSON.stringify(body));
  }) as never;

  it('si todos los métodos de lectura responden, ok los lista y failed queda vacío', async () => {
    const r = await braviaValidateMethods('10.0.0.9', 'secreto', { fetchImpl: okAll });
    expect(r.failed).toEqual([]);
    expect(r.ok).toContain('getSystemInformation');
    expect(r.ok).toContain('getVolumeInformation');
    expect(r.ok).toHaveLength(4);
  });

  it('un servicio caído cae en failed sin tumbar a los demás', async () => {
    const audioDown = (async (url: string) => {
      if (String(url).includes('/sony/audio')) return new Response('no', { status: 500 });
      return new Response(JSON.stringify({ result: [{ status: 'active' }], id: 1 }));
    }) as never;
    const r = await braviaValidateMethods('10.0.0.9', 'secreto', { fetchImpl: audioDown });
    expect(r.failed).toEqual(['getVolumeInformation']);
    expect(r.ok).toContain('getPowerStatus');
  });
});

describe('ensureActiveTv', () => {
  let nowVal = 1_000_000;
  const vault = (entries: Record<string, string>) => {
    const data = new Map(Object.entries(entries));
    const writes: Record<string, string>[] = [];
    return {
      data,
      writes,
      vaultGet: async (k: string) => data.get(k),
      vaultSetMany: async (e: Record<string, string>) => {
        writes.push(e);
        for (const [k, v] of Object.entries(e)) data.set(k, v);
      },
    };
  };
  const dead = async () => false;

  it('sin tele emparejada lo dice y no toca nada', async () => {
    const v = vault({});
    const r = await ensureActiveTv({ ...v, tcpOpen: dead, now: () => nowVal });
    expect(r.reason).toBe('no hay ninguna tele emparejada');
    expect(v.writes).toEqual([]);
  });

  it('sin registro no se escanea: descubrir no puede casar nada', async () => {
    nowVal += 120_000;
    const v = vault({ 'tv:host': '192.168.1.20', 'tv:activeBrand': 'lg' });
    let discoveries = 0;
    const r = await ensureActiveTv({
      ...v,
      tcpOpen: dead,
      discover: async () => {
        discoveries += 1;
        return [];
      },
      now: () => nowVal,
    });
    expect(r.reason).toBe('la tele activa no responde en esta red');
    expect(discoveries).toBe(0);
    expect(v.writes).toEqual([]);
  });

  it('la activa responde: no-op total (ni descubre ni escribe)', async () => {
    const v = vault({ 'tv:host': '192.168.1.20', 'tv:activeBrand': 'lg' });
    let discoveries = 0;
    const r = await ensureActiveTv({
      ...v,
      tcpOpen: async () => true,
      discover: async () => {
        discoveries += 1;
        return [];
      },
      now: () => nowVal,
    });
    expect(r).toEqual({ host: '192.168.1.20', brand: 'lg' });
    expect(discoveries).toBe(0);
    expect(v.writes).toEqual([]);
  });

  it('no responde y no se ve ninguna conocida: motivo claro y cache de fallo', async () => {
    nowVal += 120_000;
    const v = vault({
      'tv:host': '192.168.1.20',
      'tv:activeBrand': 'lg',
      'tv:tvs': JSON.stringify([lgTv]),
    });
    const r = await ensureActiveTv({
      ...v,
      tcpOpen: dead,
      discover: async () => [],
      now: () => nowVal,
    });
    expect(r.reason).toContain('no veo ninguna tele tuya encendida');

    // Cache de fallo: dentro de 60s no vuelve a escanear aunque descubrir daria algo.
    let discoveries = 0;
    nowVal += 1_000;
    const cached = await ensureActiveTv({
      ...v,
      tcpOpen: dead,
      discover: async () => {
        discoveries += 1;
        return [found('192.168.50.40', 'lg', 'uuid-lg-1')];
      },
      now: () => nowVal,
    });
    expect(cached.reason).toBe('la tele activa no responde en esta red');
    expect(discoveries).toBe(0);
  });

  it('una conocida a la vista con IP cambiada (DHCP): cambia la activa y actualiza el registro', async () => {
    nowVal += 120_000;
    const v = vault({
      'tv:host': '192.168.1.20',
      'tv:activeBrand': 'lg',
      'tv:clientKey': 'clave-lg',
      'tv:secure': '1',
      'tv:tvs': JSON.stringify([lgTv, sonyTv]),
    });
    const r = await ensureActiveTv({
      ...v,
      tcpOpen: dead,
      discover: async () => [found('192.168.50.40', 'lg', 'uuid-lg-1')],
      now: () => nowVal,
    });
    expect(r.switchedTo?.host).toBe('192.168.50.40');
    expect(r.switchedTo?.name).toBe('Salon');
    expect(r.host).toBe('192.168.50.40');
    const w = v.writes[0] ?? {};
    expect(w['tv:host']).toBe('192.168.50.40');
    expect(w['tv:activeBrand']).toBe('lg');
    expect(w['tv:clientKey']).toBe('clave-lg');
    expect(w['tv:secure']).toBe('1');
    expect(w['tv:mac']).toBe('AA:BB:CC:DD:EE:01');
    const reg = JSON.parse(w['tv:tvs'] ?? '[]') as KnownTv[];
    expect(reg.find((t) => t.uuid === 'uuid-lg-1')?.host).toBe('192.168.50.40');
    expect(reg.find((t) => t.uuid === 'uuid-sony-1')?.host).toBe('10.0.0.9');
    expect(w['tv:host']).not.toBe('192.168.1.20');
  });

  it('al llegar a la casa de la Sony: activa la Sony sin claves LG', async () => {
    nowVal += 120_000;
    const v = vault({
      'tv:host': '192.168.1.20',
      'tv:activeBrand': 'lg',
      'tv:clientKey': 'clave-lg',
      'tv:tvs': JSON.stringify([lgTv, sonyTv]),
    });
    const r = await ensureActiveTv({
      ...v,
      tcpOpen: dead,
      discover: async () => [found('10.0.0.9', 'sony', 'uuid-sony-1')],
      now: () => nowVal,
    });
    expect(r.brand).toBe('sony');
    expect(r.switchedTo?.name).toBe('Dormitorio');
    const w = v.writes[0] ?? {};
    expect(w['tv:host']).toBe('10.0.0.9');
    expect(w['tv:activeBrand']).toBe('sony');
    expect(w['tv:clientKey']).toBeUndefined();
    expect(w['tv:secure']).toBeUndefined();
  });

  it('dos teles encendidas a la vez: pide elegir y no escribe nada', async () => {
    nowVal += 120_000;
    const v = vault({
      'tv:host': '192.168.1.20',
      'tv:tvs': JSON.stringify([lgTv, sonyTv]),
    });
    const r = await ensureActiveTv({
      ...v,
      tcpOpen: dead,
      discover: async () => [
        found('192.168.50.40', 'lg', 'uuid-lg-1'),
        found('10.0.0.9', 'sony', 'uuid-sony-1'),
      ],
      now: () => nowVal,
    });
    expect(r.reason).toContain('veo 2 teles tuyas encendidas');
    expect(r.switchedTo).toBeUndefined();
    expect(v.writes).toEqual([]);
  });

  it('la misma tele descubierta dos veces (dos anuncios SSDP) cuenta como una', async () => {
    nowVal += 120_000;
    const v = vault({
      'tv:host': '192.168.1.20',
      'tv:tvs': JSON.stringify([lgTv, sonyTv]),
    });
    const r = await ensureActiveTv({
      ...v,
      tcpOpen: dead,
      discover: async () => [
        found('10.0.0.9', 'sony', 'uuid-sony-1'),
        found('10.0.0.9', 'sony', 'uuid-sony-1'),
      ],
      now: () => nowVal,
    });
    expect(r.switchedTo?.host).toBe('10.0.0.9');
  });

  it('tele de antes del registro (claves sueltas): la reconoce por MAC y la migra al cambiar', async () => {
    nowVal += 120_000;
    // LG emparejada antes de que existiera tv:tvs; su IP cambio por DHCP.
    const v = vault({
      'tv:host': '192.168.1.237',
      'tv:activeBrand': 'lg',
      'tv:clientKey': 'k-salon',
      'tv:secure': '1',
      'tv:mac': 'a8:23:fe:01:02:03',
    });
    const r = await ensureActiveTv({
      ...v,
      tcpOpen: dead,
      discover: async () => [found('192.168.1.50', 'lg', 'uuid-nueva')],
      macOf: async () => 'A8:23:FE:01:02:03',
      now: () => nowVal,
    });
    expect(r.switchedTo?.host).toBe('192.168.1.50');
    const w = v.writes[0] ?? {};
    expect(w['tv:clientKey']).toBe('k-salon');
    // Y la migracion queda escrita en el registro (momento de escritura real).
    const reg = JSON.parse(w['tv:tvs'] ?? '[]') as KnownTv[];
    expect(reg.some((t) => t.host === '192.168.1.50' && t.clientKey === 'k-salon')).toBe(true);
  });

  it('casa por MAC desde la tabla de vecinos cuando el uuid no esta guardado', async () => {
    nowVal += 120_000;
    const sinUuid: KnownTv = { ...lgTv };
    delete sinUuid.uuid;
    const v = vault({
      'tv:host': '192.168.1.20',
      'tv:tvs': JSON.stringify([sinUuid]),
    });
    const r = await ensureActiveTv({
      ...v,
      tcpOpen: dead,
      discover: async () => [found('192.168.50.40', 'lg', 'uuid-nuevo')],
      macOf: async () => 'aa:bb:cc:dd:ee:01',
      now: () => nowVal,
    });
    expect(r.switchedTo?.host).toBe('192.168.50.40');
  });

  it('registro corrupto cuenta como vacio', async () => {
    nowVal += 120_000;
    const v = vault({
      'tv:host': '192.168.1.20',
      'tv:tvs': 'esto no es json',
    });
    const r = await ensureActiveTv({
      ...v,
      tcpOpen: dead,
      discover: async () => [found('192.168.50.40', 'lg', 'uuid-lg-1')],
      now: () => nowVal,
    });
    expect(r.reason).toBe('la tele activa no responde en esta red');
  });

  it('si el descubrimiento revienta, no rompe el comando', async () => {
    nowVal += 120_000;
    const v = vault({ 'tv:host': '192.168.1.20', 'tv:tvs': JSON.stringify([lgTv]) });
    const r = await ensureActiveTv({
      ...v,
      tcpOpen: dead,
      discover: async () => {
        throw new Error('udp roto');
      },
      now: () => nowVal,
    });
    expect(r.reason).toContain('no veo ninguna tele tuya encendida');
  });
});
