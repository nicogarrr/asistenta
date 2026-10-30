import { rmSync } from 'node:fs';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import {
  claimTeleFirewallWarning,
  TV_FIREWALL_HINT,
  teleFirewallAlreadyWarned,
} from '../audio/tv-cast.js';
import { log } from '../log.js';
import { type AudioRecall, agoLabel } from '../media/recall.js';
import {
  captureCameraFrame,
  consumeRecording,
  recordCamera,
  recordCameraWithMic,
  recordMicrophone,
  toPlayableAudio,
} from '../screen/media.js';
import { recordScreen } from '../screen/recorder.js';
import { playAudioFile, playbackRestoreText } from './system.js';

/**
 * Audio, camera and microphone, in ordinary language.
 *
 * Everything here already existed as a slash command. The reason to also expose it
 * as a tool is the thing the user actually does: they send an audio, then type "suéltame
 * eso" or "reproduce el último que mandé" two messages later. That is not a command,
 * it is a sentence about a specific attachment, and it can only be answered if the
 * agent can (a) find that attachment and (b) do something with it. The recall
 * registry is half of that; this tool is the other half.
 *
 * The slash commands stay. They bypass the model entirely, which is what makes them
 * work when the provider is down or every thread is busy, and they are the fastest
 * path for something the user knows by heart. This is the slow, forgiving path for
 * everything else.
 *
 * Everything that touches hardware is declared sequential and the caller puts it
 * under the machine mutex: there is one camera, one microphone and one set of
 * speakers, so two conversations may not open them at once.
 */

/** Ceilings, matching the slash commands, so neither path can be talked out of them. */
const MAX_CLIP_SECONDS = 60;
const MAX_PLAY_BYTES = 25_000_000;

/** Solo para pruebas: vuelve a permitir el aviso del firewall (compartido con /altavoz). */
export { resetTeleFirewallWarning } from '../audio/tv-cast.js';

/**
 * Tras una orden aceptada por la tele, espera (sin bloquear la respuesta) a que la tele
 * descargue el fichero; si no lo ha hecho en el plazo, avisa al chat del firewall.
 */
function watchTeleFetch(
  hits: (() => number) | undefined,
  notify: ((text: string) => void) | undefined,
  ms = 15_000,
): void {
  if (!hits || !notify || teleFirewallAlreadyWarned()) return;
  const timer = setTimeout(() => {
    if (teleFirewallAlreadyWarned()) return;
    let served = 1;
    try {
      served = hits();
    } catch {
      return;
    }
    if (served > 0 || !claimTeleFirewallWarning()) return;
    try {
      notify(`📺 ${TV_FIREWALL_HINT}`);
    } catch {
      // Un aviso que falla no rompe nada.
    }
  }, ms);
  timer.unref?.();
}

export interface MediaToolDeps {
  /** Which chat this tool is answering, for the recall registry and for sends. */
  chatKey: string;
  recall: AudioRecall;
  /** Re-download a Telegram file id. Returns null when Telegram will not serve it. */
  downloadAudio(fileId: string, limitBytes?: number): Promise<Buffer | null>;
  /** Chat id as a number, for the upload progress indicator. */
  chatId: string;
  /** Long edge for camera frames, so photos cost the same as screenshots. */
  maxEdge: number;
  sendPhoto: (bytes: Buffer, opts?: { width?: number; height?: number }) => Promise<string | null>;
  sendVideo: (bytes: Buffer, seconds: number, label: string) => Promise<boolean>;
  sendVoice: (bytes: Buffer, seconds: number) => Promise<boolean>;
  /** Upload progress indicator, so a 20s capture does not look like a hang. */
  progress?: (what: 'upload_photo' | 'upload_voice' | 'upload_video') => Promise<void>;
  /**
   * Live views. Owned by the daemon because the loop and the editable message live
   * there; the tool only turns it on and off.
   */
  live?: {
    start(source: 'screen' | 'camera', intervalSeconds: number): Promise<string>;
    stop(): Promise<string>;
  };
  /**
   * Runs a body with the microphone free. The wake word holds the device open
   * continuously, so anything that also wants it has to be given a turn. Optional:
   * with no wake listener there is nothing to release.
   */
  withMicrophone?: <T>(fn: () => Promise<T>) => Promise<T>;
  /**
   * Wraps out-loud playback. The wake listener is listening on the same speakers the
   * audio comes out of, so without this the agent answers itself.
   */
  /**
   * Plays an already-playable MP3 on the TV. Takes ownership of the file (deletes it
   * when done). Absent when the TV target is off (PA_AUDIO_TELE) or no TV is paired.
   */
  castToTv?: (file: string) => Promise<{
    ok: boolean;
    message: string;
    hits?: () => number;
    /** Para ESTA nota en la tele (cierra el navegador/Glasshouse solo si lo abrió este cast). */
    stop?: () => Promise<unknown>;
  }>;
  /**
   * La tele aceptó el audio: quien lleva /stop apunta el «parar» de este cast para que
   * /stop en este chat lo pare (mismo plazo y mismas reglas que /altavoz tele).
   */
  onTeleCast?: (stop?: () => Promise<unknown>) => void;
  /**
   * Aviso al chat cuando la tele aceptó el audio pero no lo ha descargado en
   * `teleNoFetchMs` (15 s): suele ser el firewall de Windows. Una vez por sesión.
   */
  notifyChat?: (text: string) => void;
  teleNoFetchMs?: number;
  beforePlayback?: () => void;
  afterPlayback?: () => void;
}

const Params = Type.Object({
  action: Type.Union([
    Type.Literal('play'),
    Type.Literal('list_audio'),
    Type.Literal('camera_photo'),
    Type.Literal('camera_clip'),
    Type.Literal('camera_audio_clip'),
    Type.Literal('mic_record'),
    Type.Literal('screen_clip'),
    Type.Literal('live_view'),
  ]),
  volume: Type.Optional(
    Type.Number({ description: 'For play: 0-100. Default 100 (as loud as asked).' }),
  ),
  which: Type.Optional(
    Type.Number({
      description:
        'For play: which audio, counting back. 1 = the last one sent (default), 2 = the one before, … (list_audio shows them in that order).',
    }),
  ),
  target: Type.Optional(
    Type.Union([Type.Literal('pc'), Type.Literal('tele')], {
      description:
        'For play: where it sounds. "pc" (default) = the PC speakers; "tele" = the LG TV ("en la tele").',
    }),
  ),
  seconds: Type.Optional(Type.Number({ description: 'For the clip actions: 1-60. Default 10.' })),
  fps: Type.Optional(Type.Number({ description: 'For screen_clip: 1-15. Default 8.' })),
  source: Type.Optional(
    Type.Union([Type.Literal('screen'), Type.Literal('camera'), Type.Literal('off')]),
  ),
  intervalSeconds: Type.Optional(
    Type.Number({ description: 'For live_view on: 2-30s between frames. Default 5.' }),
  ),
});

function ok(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: 'text' as const, text }], details };
}

export function createMediaTool(deps: MediaToolDeps): AgentTool<typeof Params> {
  const clamp = (value: unknown, fallback: number, min: number, max: number): number => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(n)));
  };

  return {
    name: 'media',
    label: 'Audio y cámara',
    description: [
      'Play the audio the user sent you, and use the camera, the microphone and the screen',
      'recorder. Everything here is also a slash command, but these work when the user asks',
      'in words instead of remembering the command.',
      '',
      'action=play plays an audio THE USER SENT on the PC speakers. You never need a file',
      'path: the audio is already remembered per chat, so action=play alone plays the last one',
      'they sent, and volume=0-100 sets how loud (default 100). This is the action to use for',
      '"suéltalo", "reproduce ese audio", "sóname lo que te mandé", "ponlo a 40".',
      'target=tele plays it on the TV instead ("reprodúcelo en la tele"); target=pc (default)',
      'is the PC ("en el ordenador", "por los altavoces"). volume only applies to the PC.',
      'which=2 plays the one before the last ("el de antes", "el penúltimo"), and so on.',
      'If the user wants EVERY voice note to play on arrival, tell them to send /altavoz pc',
      '(or /altavoz tele); you cannot switch that mode on yourself.',
      'action=list_audio reports which audios are still remembered and when each arrived,',
      'with its transcript when it has one. Use it when the user says "el último" and you',
      'need to tell them which one you are about to play.',
      '',
      'action=camera_photo sends one photo from the webcam.',
      'action=camera_clip sends a silent video from the webcam (seconds, default 10).',
      'action=camera_audio_clip sends a webcam video WITH the microphone, which is what',
      '"grábame con mi voz" means.',
      'action=mic_record sends back what the room microphone hears as a voice note.',
      'action=screen_clip sends a recording of the screen (seconds, default 10).',
      'action=live_view with source=screen|camera starts a view that updates itself in place',
      'in the chat; source=off stops it. Sending frames as separate messages is impossible:',
      'Telegram allows about one message per second and every frame would stay in the chat',
      'forever.',
      '',
      'Say what you sent, in one short line, and do not claim anything worked until the',
      'result says so. If an audio is not remembered, say that the user has to send it again',
      'rather than guessing which one they meant.',
    ].join('\n'),
    parameters: Params,
    executionMode: 'sequential',
    execute: async (_id, args) => {
      switch (args.action) {
        case 'play':
          return playReceived(
            deps,
            clamp(args.volume, 100, 0, 100),
            args.target ?? 'pc',
            Math.max(1, Math.floor(args.which ?? 1)),
          );

        case 'list_audio':
          return listAudio(deps);

        case 'camera_photo': {
          await deps.progress?.('upload_photo');
          const shot = await captureCameraFrame({ maxEdge: deps.maxEdge });
          const id = await deps.sendPhoto(shot.image, { width: shot.width, height: shot.height });
          log.info('media camera photo', { chatKey: deps.chatKey, bytes: shot.image.length });
          return ok(
            id
              ? `Foto enviada de la cámara (${shot.width}x${shot.height}).`
              : 'La foto se capturó pero no se pudo enviar.',
            { sent: Boolean(id), width: shot.width, height: shot.height },
          );
        }

        case 'camera_clip': {
          const seconds = clamp(args.seconds, 10, 1, MAX_CLIP_SECONDS);
          await deps.progress?.('upload_video');
          const rec = await recordCamera({ seconds, fps: 10, maxEdge: deps.maxEdge });
          const sent = await deps.sendVideo(consumeRecording(rec.file), seconds, 'Camara');
          return ok(
            sent ? `Vídeo de la cámara enviado (${seconds}s).` : 'Vídeo grabado pero no enviado.',
            { sent, seconds },
          );
        }

        case 'camera_audio_clip': {
          const seconds = clamp(args.seconds, 10, 1, MAX_CLIP_SECONDS);
          await deps.progress?.('upload_video');
          const rec = await recordCameraWithMic({ seconds, fps: 10, maxEdge: deps.maxEdge });
          const sent = await deps.sendVideo(consumeRecording(rec.file), seconds, 'Camara y voz');
          return ok(
            sent
              ? `Vídeo con imagen y voz enviado (${seconds}s).`
              : 'Vídeo grabado pero no enviado.',
            { sent, seconds },
          );
        }

        case 'mic_record': {
          const seconds = clamp(args.seconds, 10, 1, MAX_CLIP_SECONDS);
          const record = async () => {
            await deps.progress?.('upload_voice');
            const rec = await recordMicrophone({ seconds });
            return deps.sendVoice(consumeRecording(rec.file), seconds);
          };
          const sent = await (deps.withMicrophone ? deps.withMicrophone(record) : record());
          return ok(
            sent
              ? `Nota de voz enviada con lo que oye el micrófono (${seconds}s).`
              : 'No se pudo enviar.',
            { sent, seconds },
          );
        }

        case 'screen_clip': {
          const seconds = clamp(args.seconds, 10, 1, MAX_CLIP_SECONDS);
          const fps = clamp(args.fps, 8, 1, 15);
          await deps.progress?.('upload_video');
          const rec = await recordScreen({ seconds, fps, maxEdge: deps.maxEdge });
          const sent = await deps.sendVideo(consumeRecording(rec.file), seconds, 'Pantalla');
          return ok(
            sent ? `Vídeo de la pantalla enviado (${seconds}s).` : 'Grabado pero no enviado.',
            { sent, seconds },
          );
        }

        case 'live_view': {
          const source = args.source ?? 'screen';
          if (source === 'off') {
            if (!deps.live) return ok('No hay ninguna vista en directo activa.');
            return ok(await deps.live.stop());
          }
          if (!deps.live) {
            return ok(
              'La vista en directo no está disponible en este canal; usa /screen live o /camera on.',
            );
          }
          const interval = clamp(args.intervalSeconds, 5, 2, 30);
          return ok(await deps.live.start(source, interval), { source, interval });
        }

        default:
          throw new Error(`accion desconocida: ${String(args.action)}`);
      }
    },
  };
}

/**
 * Download, convert and play the audio the user last sent.
 *
 * The conversion to MP3 is not a nicety: Windows' Media Control Interface plays
 * local files and knows nothing about Ogg/Opus, which is what Telegram voice notes
 * are. Without the transcode the request fails with a codec error that looks like a
 * broken sound card.
 *
 * Playback is wrapped so the wake-word listener goes quiet first. The speakers are
 * the microphone's other half, and an agent that hears its own playback answers it.
 */
async function playReceived(
  deps: MediaToolDeps,
  volume: number,
  target: 'pc' | 'tele' = 'pc',
  which = 1,
) {
  if (target === 'tele' && !deps.castToTv) {
    return ok(
      'Reproducir en la tele está apagado o no hay tele emparejada. Se activa con PA_AUDIO_TELE=1 (y la tele emparejada con pa tv). Puedo sonarlo en el PC si quieres.',
      { played: false, reason: 'tele off', target },
    );
  }
  const remembered = deps.recall.list(deps.chatKey);
  if (which > 1 && remembered.length > 0 && which > remembered.length) {
    return ok(
      `Solo me quedan ${remembered.length} audio${remembered.length === 1 ? '' : 's'} tuyos; dime cuál o vuelve a mandármelo.`,
      { played: false, reason: 'not that many', count: remembered.length },
    );
  }
  const audio = which > 1 ? (remembered[which - 1] ?? null) : deps.recall.last(deps.chatKey);
  if (!audio) {
    return ok('No me queda ningún audio tuyo que pueda reproducir. Mándame uno y te lo suelto.', {
      played: false,
      reason: 'nothing remembered',
    });
  }

  const bytes =
    deps.recall.read(deps.chatKey, audio.messageId) ??
    (await deps.downloadAudio(audio.fileId, MAX_PLAY_BYTES));
  if (!bytes) {
    return ok('Telegram ya no me deja descargar ese audio. Vuelve a mandármelo y lo reproduzco.', {
      played: false,
      reason: 'download failed',
      fileId: audio.fileId,
    });
  }

  let playable: string | null = null;
  try {
    playable = await toPlayableAudio(bytes, audio.mimeType);
    if (target === 'tele' && deps.castToTv) {
      // El fichero pasa a la tele: castToTv lo borra cuando la tele ya lo ha bajado.
      const file = playable;
      playable = null;
      const res = await deps.castToTv(file);
      if (res.ok) {
        watchTeleFetch(res.hits, deps.notifyChat, deps.teleNoFetchMs);
        deps.onTeleCast?.(res.stop);
      }
      return ok(res.message, { played: res.ok, target, audioAt: audio.at });
    }
    deps.beforePlayback?.();
    const res = await playAudioFile(playable, { volume });
    if (!res.ok) {
      return ok(
        `No he podido sacarlo por los altavoces: ${res.detail}. ${playbackRestoreText(res)}`,
        {
          played: false,
          reason: res.detail,
          seconds: res.seconds,
        },
      );
    }
    return ok(
      `El reproductor completó ${res.seconds}s al volumen ${res.volumeSet}%; no puedo confirmar que se haya oído en la habitación (audio recibido ${agoLabel(audio.at, deps.recall.now())}). ` +
        playbackRestoreText(res),
      {
        played: true,
        seconds: res.seconds,
        volumeSet: res.volumeSet,
        volumeRestoredTo: res.volumeRestoredTo,
        audioAt: audio.at,
      },
    );
  } catch (err) {
    // Reported, not thrown: the model can then tell the user what failed instead of
    // the harness surfacing a raw stack to somebody holding a phone.
    const why = err instanceof Error ? err.message : String(err);
    log.warn('media playback failed', { err });
    return ok(`No he podido reproducirlo: ${why}`, { played: false, reason: why });
  } finally {
    // The playable copy is scratch. The original lives in Telegram and can be
    // fetched again, so leaving an mp3 behind would only accumulate.
    if (playable) rmSync(playable, { force: true });
    deps.afterPlayback?.();
  }
}

/** What we can still play, newest first. */
function listAudio(deps: MediaToolDeps) {
  const list = deps.recall.list(deps.chatKey);
  if (!list.length) {
    return ok('No tengo audios tuyos guardados ahora mismo.', { count: 0 });
  }
  const lines = list.map((a, i) => {
    const seconds = a.durationSeconds
      ? `${Math.round(a.durationSeconds)}s`
      : 'duracion desconocida';
    const said = a.transcript ? ` dijo: "${a.transcript.slice(0, 80)}"` : '';
    return `${i + 1}. recibido ${agoLabel(a.at, deps.recall.now())} (${seconds})${said}`;
  });
  return ok(`Audios tuyos que puedo reproducir (${list.length}):\n${lines.join('\n')}`, {
    count: list.length,
    audios: list.map((a) => ({ at: a.at, transcript: a.transcript })),
  });
}
