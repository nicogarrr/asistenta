import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { log } from '../log.js';
import { paths } from '../paths.js';

/**
 * Path to the bundled ffmpeg, or null when the package shipped no binary.
 *
 * `ffmpeg-static` resolves to a string at runtime but is typed as a module object
 * under some resolution modes, hence the runtime narrowing. A wrong value here would
 * otherwise surface as an opaque spawn ENOENT much later, in the middle of the user's
 * screen recording.
 */
const FFMPEG: string | null =
  typeof ffmpegStatic === 'string'
    ? ffmpegStatic
    : ((ffmpegStatic as { default?: string }).default ?? null);

/**
 * Screen recording to H.264 MP4, so the phone can actually play it.
 *
 * Why a video file rather than a stream of screenshots:
 *
 * - Telegram documents roughly one message per second per chat, and media counts as
 *   messages, so a frame stream is capped at 1fps and every frame is re-encoded
 *   server side. A "live" screen sent as photos is neither live nor faithful.
 * - A video is one message with a real player: seeking, pause and a scrub bar.
 * - It leaves no trail. Sixty photo frames stay in the chat forever; a clip can be
 *   deleted afterwards, so the user keeps the answer instead of the clutter.
 *
 * ffmpeg comes from the `ffmpeg-static` package: a full build with gdigrab (Windows
 * screen capture) and libx264, bundled as a dependency. That detail is not cosmetic:
 * the ffmpeg shipped with Playwright is a stripped video-only build with no usable
 * H.264 encoder, which is exactly the kind of thing that only fails when you try.
 */
export interface RecordingOptions {
  seconds: number;
  /** Frames per second. 8-10 reads a UI fine and keeps the file small. */
  fps?: number;
  /** Scale the longest edge down to this many px, which bounds the file size. */
  maxEdge?: number;
  /** H.264 quality: 18 (big, clean) to 32 (small, blocky). */
  crf?: number;
  /** Region in native pixels. Defaults to the whole primary screen. */
  region?: { x: number; y: number; width: number; height: number };
}

export interface Recording {
  file: string;
  bytes: number;
  seconds: number;
  width: number;
  height: number;
}

export function ffmpegAvailable(): boolean {
  return FFMPEG !== null && existsSync(FFMPEG);
}

/**
 * Record the screen.
 *
 * The ceilings are enforced here rather than trusted from the caller: 60 seconds is
 * long enough to see what happened and short enough that a mistyped request cannot
 * spend minutes of CPU, and Telegram documents a 50MB upload cap which at 10fps and
 * CRF 26 is nowhere near for a desktop capture.
 */
export async function recordScreen(options: RecordingOptions): Promise<Recording> {
  if (!ffmpegAvailable() || !FFMPEG) {
    throw new Error(
      'ffmpeg no esta disponible (falta ffmpeg-static). Usa /screen para una captura puntual.',
    );
  }
  const seconds = Math.max(1, Math.min(60, Math.trunc(options.seconds)));
  const fps = Math.max(1, Math.min(15, Math.trunc(options.fps ?? 8)));
  const maxEdge = Math.max(320, Math.trunc(options.maxEdge ?? 1280));
  const crf = Math.max(18, Math.min(32, Math.trunc(options.crf ?? 26)));

  mkdirSync(paths.voice, { recursive: true });
  const file = join(paths.voice, `rec-${Date.now()}.mp4`);

  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'gdigrab', '-framerate', String(fps)];
  if (options.region) {
    args.push(
      '-offset_x',
      String(Math.trunc(options.region.x)),
      '-offset_y',
      String(Math.trunc(options.region.y)),
      '-video_size',
      `${Math.trunc(options.region.width)}x${Math.trunc(options.region.height)}`,
    );
  }
  args.push(
    '-i',
    'desktop',
    '-t',
    String(seconds),
    // H.264 in yuv420p because Telegram documents MPEG4 and every phone decodes
    // yuv420p. The scale filter is even-dimension safe: yuv420p cannot encode an odd
    // width or height, which is a baffling encoder error if you forget.
    '-vf',
    `scale='min(${maxEdge},iw)':-2`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    String(crf),
    '-pix_fmt',
    'yuv420p',
    // Index at the front, so the phone can start playing before the file has arrived.
    '-movflags',
    '+faststart',
    '-y',
    file,
  );

  log.info('screen recording started', { seconds, fps, maxEdge });
  let bytes: number;
  let width: number;
  let height: number;
  try {
    await run(FFMPEG, args, seconds * 1_000 + 25_000);
    if (!existsSync(file)) throw new Error('ffmpeg no produjo ningun archivo');
    bytes = statSync(file).size;
    if (bytes === 0) throw new Error('ffmpeg produjo un archivo vacio');
    ({ width, height } = await probeSize(FFMPEG, file));
  } catch (err) {
    // A failed or timed-out capture can leave a partial video of the desktop behind;
    // nobody will consume it, so it is deleted here (best effort: Windows may still
    // hold the file for a moment after the kill).
    try {
      rmSync(file, { force: true });
    } catch {
      // ignore
    }
    throw err;
  }
  log.info('screen recording ready', { bytes, width, height, seconds });
  return { file, bytes, seconds, width, height };
}

/** Read and delete a recording in one step: the caller always wants the bytes. */
export function consumeRecording(file: string): Buffer {
  const bytes = readFileSync(file);
  rmSync(file, { force: true });
  return bytes;
}

/**
 * Read the real dimensions back out of the encoded file.
 *
 * ffprobe is not bundled with ffmpeg-static, so the dimensions are parsed from
 * ffmpeg's own stream banner (`Video: h264 ... 1280x720` on stderr). That is better
 * than recomputing from the scale filter, which also rounds to even numbers and may
 * be clamping a region that is smaller than the screen.
 */
async function probeSize(ffmpeg: string, file: string): Promise<{ width: number; height: number }> {
  const stderr = await new Promise<string>((resolve) => {
    // `-i` with no output is how you ask ffmpeg to describe a file; it exits non-zero
    // on purpose, which is why the exit code is ignored.
    const child = spawn(ffmpeg, ['-hide_banner', '-i', file], { windowsHide: true });
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

/**
 * Environment for the ffmpeg child.
 *
 * ffmpeg-static is not DPI aware, so on a scaled Windows desktop (125%, 150%) gdigrab
 * sees the virtualised logical size and records only the top-left part of the screen:
 * the clip is "cut off". `__COMPAT_LAYER=HighDpiAware` is the documented way to start
 * a legacy exe DPI aware without a manifest, so gdigrab reads the physical desktop
 * like the screenshot path does. Other platforms and an already-set value pass through.
 */
export function ffmpegEnv(
  platform: NodeJS.Platform = process.platform,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (platform !== 'win32') return base;
  const current = (base.__COMPAT_LAYER ?? '').split(/\s+/).filter(Boolean);
  if (current.includes('HighDpiAware')) return base;
  return { ...base, __COMPAT_LAYER: [...current, 'HighDpiAware'].join(' ') };
}

function run(
  exe: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, env: ffmpegEnv() });
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
