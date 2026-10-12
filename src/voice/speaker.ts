/**
 * Local playback for spoken answers (capability 6).
 *
 * Deliberately NOT `playAudioFile` from tools/system.ts: that one forces the system
 * volume to 100 % (it is the "play this for me" tool and restores afterwards). A
 * conversation must not touch the machine volume. This plays through the Windows
 * Media Control Interface in a child process that can be killed at once, which is what
 * barge-in (V2) needs; V1 only waits for it to finish, bounded by a timeout.
 */

import { type ChildProcess, spawn } from 'node:child_process';

export interface Playback {
  /** Resolves when the file finished playing or was stopped; rejects on a playback error. */
  done: Promise<void>;
  /** Stops the sound immediately. Idempotent. */
  stop(): void;
}

export interface Speaker {
  play(file: string): Playback;
}

const SCRIPT = `
$File = $env:PA_SPK_FILE
Add-Type -TypeDefinition 'using System;using System.Text;using System.Runtime.InteropServices;public class PaMciSpk{[DllImport("winmm.dll",CharSet=CharSet.Unicode)]public static extern int mciSendString(string c,StringBuilder r,int l,IntPtr h);}'
$alias = 'spk' + [Guid]::NewGuid().ToString('N').Substring(0,8)
if ([PaMciSpk]::mciSendString('open "' + $File + '" alias ' + $alias, $null, 0, [IntPtr]::Zero) -ne 0) { [Console]::Error.WriteLine('no se pudo abrir el audio'); exit 2 }
$r = [PaMciSpk]::mciSendString('play ' + $alias + ' wait', $null, 0, [IntPtr]::Zero)
[PaMciSpk]::mciSendString('close ' + $alias, $null, 0, [IntPtr]::Zero) | Out-Null
if ($r -ne 0) { [Console]::Error.WriteLine('fallo al reproducir'); exit 3 }
`;

/** Upper bound for one playback; a stuck player must not hold the conversation forever. */
const MAX_PLAY_MS = 120_000;

export function createMciSpeaker(): Speaker {
  return {
    play(file: string): Playback {
      const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
      const child: ChildProcess = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        {
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
          env: { ...process.env, PA_SPK_FILE: file },
        },
      );
      let stopped = false;
      let stderr = '';
      child.stderr?.on('data', (c: Buffer) => {
        stderr = (stderr + c.toString('utf8')).slice(-500);
      });
      const done = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('la reproducción tardó demasiado y la he cortado'));
        }, MAX_PLAY_MS);
        timer.unref?.();
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (stopped || code === 0) resolve();
          else reject(new Error(stderr.trim() || `el reproductor salió con ${code}`));
        });
      });
      return {
        done,
        stop: () => {
          stopped = true;
          child.kill();
        },
      };
    },
  };
}
