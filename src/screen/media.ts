import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { childEnv } from '../child-env.js';
import { log } from '../log.js';
import { paths } from '../paths.js';

/**
 * The camera and the microphone, captured with the same bundled ffmpeg that records
 * the screen.
 *
 * Why this shape: Telegram has no way for a bot to *request* a stream. The only media
 * direction is bot to user, so "let me see the room" is answered the same way "let me
 * see the screen" is - capture locally, then send. That is not a workaround, it is the
 * only thing the platform allows, and it costs nothing because `ffmpeg-static` already
 * ships a build with the DirectShow input device that Windows exposes cameras and
 * microphones through.
 *
 * Device names are discovered rather than hardcoded. A webcam called "HD Camera" on
 * this machine is "Integrated Camera" on the next one, and a hardcoded name fails with
 * an error message about a device that does not exist, which is unactionable. The
 * discovery is cached because the answer cannot change while we run.
 */
const FFMPEG: string | null =
  typeof ffmpegStatic === 'string'
    ? ffmpegStatic
    : ((ffmpegStatic as { default?: string }).default ?? null);

export interface CaptureDevices {
  video: string | null;
  audio: string | null;
}

export interface MediaRecording {
  file: string;
  bytes: number;
  seconds: number;
  format: string;
}

let devicesCache: CaptureDevices | null = null;

/**
 * What DirectShow can see. Cached after the first call.
 *
 * The device list is on stderr even when it succeeds, which is the usual trap when
 * parsing ffmpeg: writing to stderr is not an error there, it is where all its
 * diagnostics go.
 */
export async function listCaptureDevices(): Promise<CaptureDevices> {
  if (devicesCache) return devicesCache;
  if (!ffmpegAvailable()) {
    devicesCache = { video: null, audio: null };
    return devicesCache;
  }
  const stderr = await new Promise<string>((resolve) => {
    const child = spawn(
      FFMPEG as string,
      ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
      {
        env: childEnv(),
        windowsHide: true,
      },
    );
    let text = '';
    child.stderr.on('data', (c: Buffer) => {
      text = (text + c.toString('utf8')).slice(-8000);
    });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(text));
  });

  let video: string | null = null;
  let audio: string | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const m = /"([^"]+)"\s*\((video|audio)\)/.exec(line);
    if (!m) continue;
    if (m[2] === 'video' && !video) video = m[1] ?? null;
    if (m[2] === 'audio' && !audio) audio = m[1] ?? null;
  }
  const found: CaptureDevices = { video, audio };
  devicesCache = found;
  log.info('capture devices', {
    video: found.video ?? '(none)',
    audio: found.audio ?? '(none)',
  });
  return found;
}

export function ffmpegAvailable(): boolean {
  return FFMPEG !== null && existsSync(FFMPEG);
}

/** A single frame from the camera, as JPEG bytes. */
export async function captureCameraFrame(opts: { maxEdge?: number } = {}): Promise<{
  image: Buffer;
  width: number;
  height: number;
}> {
  const devices = await listCaptureDevices();
  if (!devices.video) {
    throw new Error('no encuentro ninguna camara en este ordenador.');
  }
  mkdirSync(paths.voice, { recursive: true });
  const out = join(paths.voice, `cam-${Date.now()}.jpg`);
  const maxEdge = Math.max(320, Math.trunc(opts.maxEdge ?? 1280));
  try {
    await run(
      FFMPEG as string,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'dshow',
        '-i',
        `video=${devices.video}`,
        '-frames:v',
        '1',
        // The scale filter is even-dimension safe and bounded on the long edge, the
        // same rule the screen capture follows so both image paths cost the same in
        // tokens and share one coordinate space.
        '-vf',
        `scale='min(${maxEdge},iw)':-2`,
        '-q:v',
        '3',
        '-y',
        out,
      ],
      30_000,
    );
    const image = readFileSync(out);
    const { width, height } = await probeSize(FFMPEG as string, out);
    return { image, width, height };
  } finally {
    rmSync(out, { force: true });
  }
}

/**
 * A clip from the camera.
 *
 * Same ceiling as the screen recorder: 60 seconds is long enough to see what happened
 * and short enough that a mistyped request cannot spend minutes of CPU or fill the
 * chat with video.
 */
export async function recordCamera(options: {
  seconds: number;
  fps?: number;
  maxEdge?: number;
}): Promise<MediaRecording> {
  const devices = await listCaptureDevices();
  if (!devices.video) throw new Error('no encuentro ninguna camara en este ordenador.');
  const seconds = Math.max(1, Math.min(60, Math.trunc(options.seconds)));
  const fps = Math.max(1, Math.min(15, Math.trunc(options.fps ?? 10)));
  const maxEdge = Math.max(320, Math.trunc(options.maxEdge ?? 1280));
  mkdirSync(paths.voice, { recursive: true });
  const out = join(paths.voice, `camvid-${Date.now()}.mp4`);
  await run(
    FFMPEG as string,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'dshow',
      '-framerate',
      String(fps),
      '-i',
      `video=${devices.video}`,
      '-t',
      String(seconds),
      '-vf',
      `scale='min(${maxEdge},iw)':-2`,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '26',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-y',
      out,
    ],
    seconds * 1000 + 30_000,
  );
  const bytes = statSync(out).size;
  return { file: out, bytes, seconds, format: 'mp4' };
}

/**
 * Camera *and* microphone in one file.
 *
 * Two separate captures stitched together afterwards was the obvious way to do this
 * and it is wrong: the two ffmpeg processes open at slightly different moments, so
 * the audio is offset from the video by however long the second spawn took, and any
 * offset is instantly audible as lip-sync drift. One process with two DirectShow
 * inputs shares one clock, so `-map` pairs them frame-accurately.
 *
 * AAC rather than Opus because this is video: Telegram will re-encode an opus track
 * inside an mp4 anyway, and `aac` is what every player on the machine has.
 *
 * `-shortest` closes the file when the camera stops, so a camera that delivers its
 * first frame late cannot leave a video padded with silence to the `-t` ceiling.
 */
export async function recordCameraWithMic(options: {
  seconds: number;
  fps?: number;
  maxEdge?: number;
}): Promise<MediaRecording> {
  const devices = await listCaptureDevices();
  if (!devices.video) throw new Error('no encuentro ninguna camara en este ordenador.');
  if (!devices.audio) {
    throw new Error('no encuentro ningun microfono en este ordenador.');
  }
  const seconds = Math.max(1, Math.min(60, Math.trunc(options.seconds)));
  const fps = Math.max(1, Math.min(15, Math.trunc(options.fps ?? 10)));
  const maxEdge = Math.max(320, Math.trunc(options.maxEdge ?? 1280));
  mkdirSync(paths.voice, { recursive: true });
  const out = join(paths.voice, `camav-${Date.now()}.mp4`);
  await run(
    FFMPEG as string,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      // Input 0: camera. Input 1: microphone. Each dshow needs its own -f, which is
      // why this is not the single `-i device=` form the single-input calls use.
      '-f',
      'dshow',
      '-framerate',
      String(fps),
      '-i',
      `video=${devices.video}`,
      '-f',
      'dshow',
      '-i',
      `audio=${devices.audio}`,
      '-t',
      String(seconds),
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-vf',
      `scale='min(${maxEdge},iw)':-2`,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '26',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-ac',
      '1',
      '-shortest',
      '-movflags',
      '+faststart',
      '-y',
      out,
    ],
    seconds * 1000 + 30_000,
  );
  const bytes = statSync(out).size;
  return { file: out, bytes, seconds, format: 'mp4' };
}

/**
 * A recording of the microphone, as Ogg/Opus.
 *
 * Ogg/Opus rather than MP3 because that is the format Telegram renders as a real
 * voice note with a waveform, and `libopus` is in the same bundled ffmpeg. MP3 would
 * arrive as a music-player attachment, which is the wrong affordance for "here is what
 * my microphone hears".
 */
export async function recordMicrophone(options: { seconds: number }): Promise<MediaRecording> {
  const devices = await listCaptureDevices();
  if (!devices.audio) throw new Error('no encuentro ningun microfono en este ordenador.');
  const seconds = Math.max(1, Math.min(60, Math.trunc(options.seconds)));
  mkdirSync(paths.voice, { recursive: true });
  const out = join(paths.voice, `mic-${Date.now()}.ogg`);
  await run(
    FFMPEG as string,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'dshow',
      '-i',
      `audio=${devices.audio}`,
      '-t',
      String(seconds),
      // Mono at 32kbps: a voice note does not need stereo, and half the bitrate is
      // half the upload for the same intelligibility.
      '-ac',
      '1',
      '-c:a',
      'libopus',
      '-b:a',
      '32k',
      '-y',
      out,
    ],
    seconds * 1000 + 30_000,
  );
  const bytes = statSync(out).size;
  return { file: out, bytes, seconds, format: 'ogg' };
}

/** Read and delete a recording in one step: the caller always wants the bytes. */
export function consumeRecording(file: string): Buffer {
  const bytes = readFileSync(file);
  rmSync(file, { force: true });
  return bytes;
}

/**
 * Turn any audio into something Windows can play out loud.
 *
 * Telegram voice notes are Ogg/Opus and the Media Control Interface that plays files
 * through the speakers has no idea what an ogg is. Rather than teaching MCI a codec it
 * will never have, the file is re-encoded once to MP3 with the same bundled ffmpeg.
 * The copy is written to the voice scratch dir and the caller deletes it: an audio the
 * user sent is transient input, not something to keep.
 */
export async function toPlayableAudio(bytes: Buffer, hint = 'input'): Promise<string> {
  if (!ffmpegAvailable()) {
    throw new Error('no puedo convertir el audio sin ffmpeg.');
  }
  mkdirSync(paths.voice, { recursive: true });
  const dir = paths.voice;
  const src = join(dir, `in-${Date.now()}-${hint.replace(/[^\w.-]/g, '')}.bin`);
  const out = join(dir, `play-${Date.now()}.mp3`);
  writeFileSync(src, bytes);
  try {
    await run(
      FFMPEG as string,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        src,
        '-vn',
        '-ac',
        '1',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '128k',
        '-y',
        out,
      ],
      60_000,
    );
    return out;
  } finally {
    rmSync(src, { force: true });
  }
}

/**
 * Read the real dimensions back out of the encoded file.
 *
 * ffprobe is not bundled, so the size is parsed from ffmpeg's own stream banner on
 * stderr. Better than recomputing from the scale filter, which also rounds to even
 * numbers and may be clamping something smaller than the frame.
 */
async function probeSize(ffmpeg: string, file: string): Promise<{ width: number; height: number }> {
  const stderr = await new Promise<string>((resolve) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-i', file], {
      env: childEnv(),
      windowsHide: true,
    });
    let text = '';
    child.stderr.on('data', (c: Buffer) => {
      text = (text + c.toString('utf8')).slice(-4000);
    });
    child.on('error', () => resolve(text));
    child.on('close', () => resolve(text));
  });
  const match = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(stderr);
  return match?.[1]
    ? { width: Number(match[1]), height: Number(match[2] ?? 0) }
    : { width: 0, height: 0 };
}

function run(
  exe: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { env: childEnv(), windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      // ffmpeg is chatty on failure and silent on success, so only the tail is kept.
      stderr = (stderr + c.toString('utf8')).slice(-4000);
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`ffmpeg tardo mas de ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`ffmpeg salio con ${code}: ${stderr.trim() || '(sin salida)'}`));
    });
  });
}
