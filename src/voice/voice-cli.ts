/**
 * `pa voice ...` — enrolamiento y consulta de las voces del hogar (brecha 3b).
 *
 *   pa voice enroll <nombre> <audio...>   Enrola/re-enrola una voz (wav, mp3, ogg…)
 *   pa voice verify <audio>               Puntuación de un audio contra los perfiles
 *   pa voice list                         Perfiles enrolados
 *   pa voice remove <nombre>              Borra un perfil
 *
 * Los audios pasan por ffmpeg a 16 kHz mono (cualquier contenedor que ffmpeg
 * sniffee). La puerta en la conversación por voz solo se activa con
 * PA_SPEAKER_VERIFY=1 Y al menos un perfil enrolado (ver src/cli.ts).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../paths.js';
import { decodeAudioWithFfmpeg, ffmpegDecoderAvailable } from './decode.js';
import { SPK_SAMPLE_RATE, SpeakerVerifier, speakerGateConfigFromEnv } from './speaker-verify.js';

export const speakerProfilesFile = (): string => join(paths.voice, 'speaker-profiles.json');

const USAGE =
  'uso: pa voice enroll <nombre> <audio...> | pa voice verify <audio> | ' +
  'pa voice list | pa voice remove <nombre>\n';

const decode = async (file: string) => {
  const pcm = await decodeAudioWithFfmpeg(await readFile(file));
  if (pcm.sampleRate !== SPK_SAMPLE_RATE) {
    throw new Error(
      `muestreo inesperado ${pcm.sampleRate} Hz (ffmpeg debió dar ${SPK_SAMPLE_RATE})`,
    );
  }
  return pcm.samples;
};

export async function voiceCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (!ffmpegDecoderAvailable()) {
    process.stderr.write('ffmpeg no está disponible; instala las dependencias (npm ci).\n');
    return 1;
  }
  const verifier = await SpeakerVerifier.load(speakerProfilesFile(), speakerGateConfigFromEnv());
  try {
    switch (sub) {
      case 'enroll': {
        const [name, ...files] = rest;
        if (!name || files.length === 0) {
          process.stderr.write(USAGE);
          return 2;
        }
        const samples = [];
        for (const f of files) samples.push(await decode(f));
        const info = await verifier.enroll(name, samples);
        process.stdout.write(
          `Voz enrolada: ${info.name} (${info.utterances} muestras). ` +
            'Activa la puerta con PA_SPEAKER_VERIFY=1.\n',
        );
        return 0;
      }
      case 'verify': {
        const [file] = rest;
        if (!file) {
          process.stderr.write(USAGE);
          return 2;
        }
        const r = await verifier.verify(await decode(file));
        const fmt = (v: number) => (Number.isNaN(v) ? '—' : v.toFixed(3));
        process.stdout.write(
          `mejor=${r.speaker ?? '—'} score=${fmt(r.score)} segundo=${fmt(r.second)} ` +
            `umbral=${verifier.threshold} margen=${verifier.margin} -> ` +
            `${r.accepted ? 'ACEPTADA' : 'RECHAZADA'}\n`,
        );
        return r.accepted ? 0 : 1;
      }
      case 'list': {
        const profiles = verifier.list();
        if (profiles.length === 0) {
          process.stdout.write(
            'No hay voces enroladas. Usa: pa voice enroll <nombre> <audio...>\n',
          );
          return 0;
        }
        for (const p of profiles) {
          process.stdout.write(`${p.name}\t${p.utterances} muestras\tenrolada ${p.enrolledAt}\n`);
        }
        return 0;
      }
      case 'remove': {
        const [name] = rest;
        if (!name) {
          process.stderr.write(USAGE);
          return 2;
        }
        const gone = await verifier.remove(name);
        process.stdout.write(
          gone ? `Perfil borrado: ${name}\n` : `No existía el perfil: ${name}\n`,
        );
        return gone ? 0 : 1;
      }
      default:
        process.stderr.write(USAGE);
        return 2;
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
