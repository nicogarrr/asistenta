/**
 * Local text-to-speech via Windows SAPI.
 *
 * SAPI ships with Windows and needs no key, no download and no network, which is
 * the whole point: the free/offline constraint rules out every hosted TTS API,
 * and the offline alternative (a local neural model) is a multi-gigabyte download
 * for a robot voice. A neural offline voice can be layered in later behind the
 * same `Tts` interface.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { encodeMp3, resampleLinear, wavToPcm } from './audio.js';

const execFileAsync = promisify(execFile);

export interface TtsAudio {
  data: Buffer;
  mimeType: 'audio/mpeg' | 'audio/wav';
  format: 'mp3' | 'wav';
  /** What was actually spoken, so callers can log it when something looks wrong. */
  text: string;
  /** Set when the input was longer than `MAX_CHARS` and only the head was spoken. */
  truncated: boolean;
}

export interface Tts {
  name: string;
  speak(text: string, opts?: { voice?: string }): Promise<TtsAudio>;
}

/**
 * Upper bound on a single synthesis.
 *
 * SAPI speaks at roughly 150 wpm, so 4000 characters is over 25 minutes of audio
 * and would exceed both the process timeout and Telegram's per-message limits.
 * The text is truncated at a word boundary and the caller is told it happened,
 * rather than silently speaking a prefix or blocking forever.
 */
const MAX_CHARS = 4000;

/**
 * Process ceiling. Roughly 6x the synthesis time for text at `MAX_CHARS`, which
 * bounds a wedged or hung SAPI without cutting off a legitimately long reply.
 */
const SYNTHESIS_TIMEOUT_MS = 60_000;

/**
 * Bitrate for the outgoing mp3.
 *
 * 32kbps mono is the knee of the curve for speech: measured here at ~4KB per
 * second of audio, so a 30-second reply is roughly 120KB. Below ~24kbps the
 * artefacts land in the 4-8kHz band where sibilants live and become audible.
 */
const MP3_KBPS = 32;

/** SAPI writes 22050Hz mono by default; resampled down to this before encoding. */
const MP3_SAMPLE_RATE = 16_000;

/**
 * Truncate at a word boundary near the limit.
 *
 * Cutting mid-word is audible and makes the truncation obvious in a way that
 * reads like a bug rather than a limit, so we back up to the last space.
 */
function truncate(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  const cut = text.slice(0, MAX_CHARS);
  const space = cut.lastIndexOf(' ');
  return space > MAX_CHARS * 0.9 ? cut.slice(0, space) : cut;
}

/**
 * Build the PowerShell script as a file, and pass the text as a file too.
 *
 * Both details are load-bearing:
 *
 * - The script goes through `-File` rather than `-Command`. Inline, the text
 *   would have to survive two layers of PowerShell quoting (and cmd-style
 *   escaping through exec), where a `$` or a backtick silently changes what runs.
 * - The text is written to disk and read with an explicit UTF-8 encoding, not
 *   passed through the command line. PowerShell 5.1 decodes argv and `.txt` files
 *   using the system codepage (Windows-1252 here), so "ñ", "¿" and emoji arrive as
 *   mojibake or are dropped. Verified: "Añadir más años ¿vale?" round-tripped
 *   through this path byte-for-byte.
 *
 * Paths go in through the environment rather than being interpolated into the
 * script, so a temp path containing a quote cannot break out of the string.
 */
function scriptSource(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Speech',
    '$text = [System.IO.File]::ReadAllText($env:PA_TTS_TEXT, [System.Text.Encoding]::UTF8)',
    '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    'try {',
    '  $synth.SetOutputToWaveFile($env:PA_TTS_WAV)',
    '  if ($env:PA_TTS_VOICE) { $synth.SelectVoice($env:PA_TTS_VOICE) }',
    '  if ($env:PA_TTS_RATE) { $synth.Rate = [int]$env:PA_TTS_RATE }',
    '  if ($env:PA_TTS_VOLUME) { $synth.Volume = [int]$env:PA_TTS_VOLUME }',
    '  $synth.Speak($text)',
    '} finally {',
    // Without this the wave file is left untruncated and unreadable: the format
    // header is written on close, so a missing Dispose yields a zero-length or
    // header-only file.
    '  $synth.SetOutputToNull()',
    '  $synth.Dispose()',
    '}',
  ].join('\n');
}

/**
 * SAPI-backed synthesis. `rate` is SAPI's own -10..10 scale and `volume` is 0..100;
 * both are passed through untouched, and SAPI throws on out-of-range values.
 */
export function createSapiTts(opts: { rate?: number; volume?: number } = {}): Tts {
  return {
    name: 'sapi',
    async speak(text: string, speakOpts: { voice?: string } = {}): Promise<TtsAudio> {
      const trimmed = text.trim();
      if (!trimmed) throw new Error('no hay texto que decir');

      const spoken = truncate(trimmed);
      const dir = mkdtempSync(join(tmpdir(), 'pa-tts-'));
      const textFile = join(dir, 'texto.txt');
      const wavFile = join(dir, 'voz.wav');
      const scriptFile = join(dir, 'tts.ps1');

      try {
        // No BOM: ReadAllText is told the encoding explicitly, and a BOM would
        // then be read as a leading U+FEFF that SAPI speaks as a pause.
        writeFileSync(textFile, spoken, 'utf8');
        writeFileSync(scriptFile, scriptSource(), 'ascii');

        await execFileAsync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-File', scriptFile],
          {
            encoding: 'utf8',
            timeout: SYNTHESIS_TIMEOUT_MS,
            windowsHide: true,
            env: {
              ...process.env,
              PA_TTS_TEXT: textFile,
              PA_TTS_WAV: wavFile,
              ...(speakOpts.voice ? { PA_TTS_VOICE: speakOpts.voice } : {}),
              ...(opts.rate !== undefined ? { PA_TTS_RATE: String(opts.rate) } : {}),
              ...(opts.volume !== undefined ? { PA_TTS_VOLUME: String(opts.volume) } : {}),
            },
          },
        );

        const decoded = wavToPcm(readFileSync(wavFile));
        // Resampled to 16k before mp3: SAPI writes 22.05kHz, and encoding that
        // rate costs ~25% more bytes for no audible gain, since nothing above
        // 8kHz matters for intelligibility of speech.
        const pcm = resampleLinear(decoded.samples, decoded.sampleRate, MP3_SAMPLE_RATE);

        return {
          data: encodeMp3(pcm, MP3_SAMPLE_RATE, MP3_KBPS),
          mimeType: 'audio/mpeg',
          format: 'mp3',
          text: spoken,
          truncated: spoken.length < trimmed.length,
        };
      } catch (err) {
        const stderr =
          err && typeof err === 'object' && 'stderr' in err ? String(err.stderr).trim() : '';
        const message = stderr || (err instanceof Error ? err.message : String(err));
        throw new Error(`la sintesis de voz fallo: ${message}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Installed SAPI voice names, for `/voz <nombre>` style selection.
 *
 * Never throws: a missing System.Speech assembly (Windows Nano, a container) is
 * a real environment and the caller wants an empty list it can report, not an
 * exception that takes down the command handler.
 */
export async function voices(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }; $s.Dispose()',
      ],
      { encoding: 'utf8', timeout: 15_000, windowsHide: true },
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
