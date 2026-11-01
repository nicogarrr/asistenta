/**
 * Reads a PNG screenshot just enough to check it is a real picture of the probe's page.
 *
 * The probe paints its test page with a colour picked at random for each run and only
 * sent to the browser. A screenshot that really comes from that page is mostly that
 * colour; bytes made up by the attempt's code are not a PNG, or not of that colour.
 * Handles what browsers produce: 8-bit RGB or RGBA, not interlaced.
 */
import { inflateSync } from 'node:zlib';

export type Rgb = [number, number, number];

/** Share of pixels (0..1) within `tol` of `colour`, or null if the bytes are not a PNG we can read. */
export function pngColourShare(b64: string, colour: Rgb, tol = 12): number | null {
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a)
    return null;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  for (let off = 8; off + 12 <= buf.length; ) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data.readUInt8(8);
      const ct = data.readUInt8(9);
      if (depth !== 8 || data.readUInt8(12) !== 0 || (ct !== 2 && ct !== 6)) return null;
      channels = ct === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!width || !height || !channels || width * height > 40_000_000) return null;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return null;
  const prev = Buffer.alloc(stride);
  const row = Buffer.alloc(stride);
  let hits = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw.readUInt8(y * (stride + 1));
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row.readUInt8(i - channels) : 0;
      const b = prev.readUInt8(i);
      const c = i >= channels ? prev.readUInt8(i - channels) : 0;
      let p = 0;
      if (filter === 1) p = a;
      else if (filter === 2) p = b;
      else if (filter === 3) p = (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) return null;
      row[i] = (src.readUInt8(i) + p) & 0xff;
    }
    for (let x = 0; x < stride; x += channels) {
      if (
        Math.abs(row.readUInt8(x) - colour[0]) <= tol &&
        Math.abs(row.readUInt8(x + 1) - colour[1]) <= tol &&
        Math.abs(row.readUInt8(x + 2) - colour[2]) <= tol
      )
        hits++;
    }
    row.copy(prev);
  }
  return hits / (width * height);
}
