import { createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

/**
 * Certificado autofirmado para la página del móvil, sin openssl (Windows no lo trae).
 * Safari solo da el movimiento del iPhone a páginas HTTPS, y en casa no hay un dominio
 * con certificado de verdad: se genera uno (ECDSA P-256, 30 días) con la IP del PC en los
 * nombres alternativos. Safari avisará una vez de que no es de confianza: hay que seguir.
 * shortcut: DER escrito a mano para lo justo (un certificado v3 con SAN); si hiciera falta
 * más (cadenas, CA propia), usar una librería.
 */
const len = (n: number): Buffer => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...p: Buffer[]) => tlv(0x30, ...p);
const set = (...p: Buffer[]) => tlv(0x31, ...p);
const octets = (b: Buffer) => tlv(0x04, b);
const bitString = (b: Buffer) => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const int = (b: Buffer) => {
  let x = b;
  while (x.length > 1 && x[0] === 0 && ((x[1] ?? 0) & 0x80) === 0) x = x.subarray(1);
  if (((x[0] ?? 0) & 0x80) !== 0) x = Buffer.concat([Buffer.from([0]), x]);
  return tlv(0x02, x);
};
const oid = (dotted: string): Buffer => {
  const a = dotted.split('.').map(Number);
  const out: number[] = [(a[0] ?? 0) * 40 + (a[1] ?? 0)];
  for (const v of a.slice(2)) {
    const chunk: number[] = [v & 0x7f];
    for (let n = Math.floor(v / 128); n > 0; n = Math.floor(n / 128))
      chunk.unshift((n & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
};
const utc = (d: Date): Buffer => {
  const p = (n: number) => String(n).padStart(2, '0');
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, 'ascii'));
};

export interface SelfSigned {
  cert: string;
  key: string;
}

function ipv4Bytes(ip: string): Buffer {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`IP no válida para el certificado: ${ip}`);
  }
  return Buffer.from(parts);
}

export function makeSelfSignedCert(ips: string[], now: Date = new Date()): SelfSigned {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const name = seq(set(seq(oid('2.5.4.3'), utf8('Asistenta apuntar'))));
  const sigAlg = seq(oid('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256
  const notBefore = new Date(now.getTime() - 3_600_000);
  const notAfter = new Date(now.getTime() + 30 * 86_400_000);
  const san = seq(
    tlv(0x82, Buffer.from('localhost', 'ascii')),
    ...ips.map((ip) => tlv(0x87, ipv4Bytes(ip))),
  );
  const extensions = tlv(
    0xa3,
    seq(
      seq(oid('2.5.29.19'), bool(true), octets(seq(bool(false)))), // basicConstraints CA:false
      seq(oid('2.5.29.17'), octets(san)), // subjectAltName
    ),
  );
  const serial = randomBytes(16);
  serial[0] = (serial[0] ?? 1) & 0x7f;
  const tbs = seq(
    tlv(0xa0, int(Buffer.from([2]))),
    int(serial),
    sigAlg,
    name,
    seq(utc(notBefore), utc(notAfter)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions,
  );
  const signature = sign(
    'sha256',
    tbs,
    createPrivateKey(privateKey.export({ type: 'pkcs8', format: 'pem' })),
  );
  const der = seq(tbs, sigAlg, bitString(signature));
  const pem = (label: string, b: Buffer) =>
    `-----BEGIN ${label}-----\n${(b.toString('base64').match(/.{1,64}/g) ?? []).join('\n')}\n-----END ${label}-----\n`;
  return {
    cert: pem('CERTIFICATE', der),
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}
