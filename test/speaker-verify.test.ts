// Brecha 3b: enrolamiento y verificación de hablante (mecánica, voces
// sintéticas deterministas). La frontera entre dos voces REALES del hogar se
// mide en el PC de Nico cuando existan las muestras de la segunda persona:
// este test valida enrolar/verificar/persistir/rechazar, no esa frontera.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractLogMelEmbedding,
  SPK_SAMPLE_RATE,
  SpeakerVerifier,
  speakerGateConfigFromEnv,
} from '../src/voice/speaker-verify.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

/** RNG determinista (mulberry32). */
const rng = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * "Voz" sintética: pila de armónicos con f0 y envolvente de formante propios,
 * AM silábica y jitter. Dos hablantes = dos (f0, formante) bien separados.
 */
function voiceLike(
  f0: number,
  formantHz: number,
  seconds: number,
  seed: number,
  amp = 0.25,
): Float32Array {
  const rand = rng(seed);
  const n = Math.floor(seconds * SPK_SAMPLE_RATE);
  const out = new Float32Array(n);
  const harmonics = 12;
  const syllHz = 3 + rand() * 2;
  const phase = rand() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const t = i / SPK_SAMPLE_RATE;
    const jitter = 1 + 0.01 * Math.sin(2 * Math.PI * 5.3 * t + phase);
    let v = 0;
    for (let k = 1; k <= harmonics; k++) {
      const f = k * f0 * jitter;
      const w = Math.exp(-((f - formantHz) ** 2) / (2 * 600 ** 2)) / k;
      v += w * Math.sin(2 * Math.PI * f * t);
    }
    const am = 0.55 + 0.45 * Math.max(0, Math.sin(2 * Math.PI * syllHz * t + phase));
    out[i] = v * am * amp + (rand() - 0.5) * 0.004;
  }
  return out;
}

const noise = (seconds: number, seed: number, amp = 0.2): Float32Array => {
  const rand = rng(seed);
  const out = new Float32Array(Math.floor(seconds * SPK_SAMPLE_RATE));
  for (let i = 0; i < out.length; i++) out[i] = (rand() - 0.5) * 2 * amp;
  return out;
};

const VOICE_A = (seed: number) => voiceLike(120, 700, 1.6, seed);
const VOICE_B = (seed: number) => voiceLike(215, 1800, 1.6, seed);

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const verifier = async (threshold?: number) => {
  dir = mkdtempSync(join(tmpdir(), 'spk-'));
  return SpeakerVerifier.load(join(dir, 'profiles.json'), threshold ? { threshold } : {});
};

describe('speaker-verify: enrolamiento y verificación (brecha 3b)', () => {
  it('acepta al hablante enrolado y rechaza al no enrolado y el ruido', async () => {
    const v = await verifier();
    await v.enroll('nico', [VOICE_A(1), VOICE_A(2), VOICE_A(3)]);

    const own = await v.verify(VOICE_A(7));
    expect(own.accepted).toBe(true);
    expect(own.speaker).toBe('nico');

    const stranger = await v.verify(VOICE_B(8));
    expect(stranger.accepted).toBe(false);

    const hiss = await v.verify(noise(1.6, 9));
    expect(hiss.accepted).toBe(false);
  });

  it('el coseno intra-hablante supera al inter-hablante con margen claro', async () => {
    const v = await verifier();
    await v.enroll('nico', [VOICE_A(1), VOICE_A(2)]);
    await v.enroll('pareja', [VOICE_B(3), VOICE_B(4)]);

    const asA = await v.verify(VOICE_A(11));
    expect(asA.speaker).toBe('nico');
    expect(asA.accepted).toBe(true);
    const asB = await v.verify(VOICE_B(12));
    expect(asB.speaker).toBe('pareja');
    expect(asB.accepted).toBe(true);
    // La mejor puntuación de cada uno es con su propio perfil.
    expect(asA.score).toBeGreaterThan(asA.second);
    expect(asB.score).toBeGreaterThan(asB.second);
  });

  it('persiste perfiles en disco (JSON atómico) y los recarga', async () => {
    const v = await verifier();
    await v.enroll('nico', [VOICE_A(1), VOICE_A(2)]);
    const again = await SpeakerVerifier.load(join(dir, 'profiles.json'));
    expect(again.list().map((p) => p.name)).toEqual(['nico']);
    const r = await again.verify(VOICE_A(5));
    expect(r.accepted).toBe(true);
  });

  it('remove borra el perfil y tras eso su voz ya no entra', async () => {
    const v = await verifier();
    await v.enroll('nico', [VOICE_A(1)]);
    expect(await v.remove('nico')).toBe(true);
    expect(await v.remove('nico')).toBe(false);
    const r = await v.verify(VOICE_A(2));
    expect(r.accepted).toBe(false);
    expect(r.speaker).toBeNull();
  });

  it('re-enrolar sustituye el perfil (misma lista, utterances actualizados)', async () => {
    const v = await verifier();
    await v.enroll('nico', [VOICE_A(1)]);
    await v.enroll('nico', [VOICE_A(2), VOICE_A(3), VOICE_A(4)]);
    const list = v.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.utterances).toBe(3);
  });

  it('sin perfiles no se acepta nada', async () => {
    const v = await verifier();
    const r = await v.verify(VOICE_A(1));
    expect(r.accepted).toBe(false);
    expect(r.speaker).toBeNull();
  });

  it('audio demasiado corto es error honesto, no un embedding falso', async () => {
    expect(() => extractLogMelEmbedding(new Float32Array(500))).toThrow(/demasiado corto/);
    const v = await verifier();
    await v.enroll('nico', [VOICE_A(1)]);
    await expect(v.verify(new Float32Array(500))).rejects.toThrow(/demasiado corto/);
  });

  it('un umbral altísimo rechaza hasta al propio hablante (config env)', async () => {
    const v = await verifier(1.000001);
    await v.enroll('nico', [VOICE_A(1)]);
    const r = await v.verify(VOICE_A(2));
    expect(r.accepted).toBe(false);
    const cfg = speakerGateConfigFromEnv({ PA_SPEAKER_THRESHOLD: '0.7', PA_SPEAKER_MARGIN: '0.1' });
    expect(cfg.threshold).toBe(0.7);
    expect(cfg.margin).toBe(0.1);
    const bad = speakerGateConfigFromEnv({ PA_SPEAKER_THRESHOLD: 'nope' });
    expect(bad.threshold).toBeGreaterThan(0);
  });
});
