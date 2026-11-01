import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { childEnv } from '../child-env.js';
import { log } from '../log.js';
import { psErrorSummary } from './ps-error.js';

const execFileAsync = promisify(execFile);

/**
 * The machine itself: sound, the lock screen, and a quick health read.
 *
 * This exists because "can you turn it down" is a normal thing to ask a personal
 * assistant, and every one of these is a few lines of what Windows already ships. No
 * extra package, no service, no key.
 *
 * Volume goes through `winmm.dll`, and the first attempt to use it failed in a way
 * worth recording: the level is packed as `left | (right << 16)`, so anything above
 * 50% produces a value larger than Int32.Max. Passing that to the C# `uint` parameter
 * without a `[uint32]` cast made the call fail silently - setting 90% and reading back
 * 100% is exactly what that looked like from outside. The value is now built as an
 * unsigned literal in PowerShell and verified by reading it back after every write,
 * because a set that quietly did nothing is the failure this tool exists to not report.
 *
 * The Core Audio endpoint (`IAudioEndpointVolume`) was tried first and abandoned: the
 * COM interop for `IMMDevice::Activate` returned S_OK with a null interface pointer
 * through three different marshalling shapes, which is not worth more time when the
 * wave channel that `winmm` drives is the same slider on this machine.
 */
export interface VolumeState {
  level: number;
  muted: boolean;
}

export interface SystemStatus {
  batteryPercent: number | null;
  onBattery: boolean;
  diskFreeGb: number;
  diskTotalGb: number;
  ramUsedGb: number;
  ramTotalGb: number;
  online: boolean;
  localIp: string | null;
}

async function ps(
  script: string,
  timeoutMs = 20_000,
  strict = false,
  signal?: AbortSignal,
): Promise<string> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      env: childEnv(),
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      // /stop: matar el PowerShell que reproduce corta el sonido (MCI vive en ese proceso).
      ...(signal ? { signal } : {}),
    },
  ).catch((err: unknown) => {
    log.warn('system helper failed', psErrorSummary(err));
    if (strict) throw err;
    return { stdout: '' };
  });
  return stdout;
}

/**
 * The two winmm calls, as one Add-Type block.
 *
 * A wave volume is packed as `left | (right << 16)`, both channels 0..0xFFFF. The
 * packing is done in PowerShell from a per-channel value rather than passed in as a
 * literal, because a packed level above 50% is larger than Int32.Max: PowerShell
 * parses `0xe666e666` as a *negative* Int32, and `[uint32]` of a negative number
 * throws. The exception was swallowed by the process helper, which is why the first
 * version reported "Volumen al 90%" and then read back 100%. The shift is done on
 * [uint64] so nothing overflows on the way.
 */
const VOL_LIB = `
if (-not ('PaVol' -as [type])) {
  Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class PaVol{[DllImport("winmm.dll")]public static extern int waveOutGetVolume(IntPtr h,out uint d);[DllImport("winmm.dll")]public static extern int waveOutSetVolume(IntPtr h,uint d);}'
}
`;

export async function getVolume(): Promise<VolumeState> {
  const out = await ps(
    `${VOL_LIB}
$v = [uint32]0
$hr = [PaVol]::waveOutGetVolume([IntPtr]::Zero, [ref]$v)
if ($hr -ne 0) { throw "volume read failed $hr" }
$left = $v -band 0xFFFF
$right = ($v -shr 16) -band 0xFFFF
$level = [int][Math]::Round((($left + $right) / 2.0) / 65535 * 100)
Write-Output ("$level|" + $(if ($left -eq 0 -and $right -eq 0) { '1' } else { '0' }))`,
    20_000,
    true,
  );
  if (!/^(?:100|[1-9]?\d)\|[01]$/.test(out.trim()))
    throw new Error('no se pudo leer el volumen del dispositivo');
  const [levelText, mutedText] = out.trim().split('|');
  return {
    level: Number(levelText),
    muted: mutedText === '1',
  };
}

export async function setVolume(level: number): Promise<VolumeState> {
  const v = Math.max(0, Math.min(100, Math.trunc(level)));
  const raw = Math.round((v / 100) * 65535) & 0xffff;
  const out = await ps(
    `${VOL_LIB}
$raw = [uint32]${raw}
$packed = [uint32](([uint64]$raw -shl 16) -bor [uint64]$raw)
$hr = [PaVol]::waveOutSetVolume([IntPtr]::Zero, $packed)
if ($hr -ne 0) { throw "volume write failed $hr" }
Write-Output ("set hr=$hr")`,
    20_000,
    true,
  );
  // Read back rather than trusting the value we sent: the call reports success even
  // when the device refuses, and a set that silently did nothing is exactly the
  // failure this tool exists to avoid reporting as done.
  const state = await getVolume();
  // `out` always carries hr=0 here (a non-zero hr throws above), so the old
  // `!out.includes('hr=0')` guard made this warning unreachable. Allow ±1 for
  // the 0-65535 rounding on the way back.
  if (Math.abs(state.level - v) > 1) {
    log.warn('volume set did not take', { wanted: v, got: state.level, out: out.trim() });
  }
  return state;
}

/**
 * Mute and unmute with the hardware mute key.
 *
 * Not by setting the volume to zero: that throws away whatever level the user had, so
 * unmuting would return them to a level they never chose. The mute key is what the
 * keyboard does and Windows keeps the level behind it.
 */
export async function toggleMute(): Promise<VolumeState> {
  await ps(`if (-not ('PaKey' -as [type])) {
  Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class PaKey{[DllImport("user32.dll")]public static extern void keybd_event(byte b,byte s,uint f,UIntPtr e);}'
}
# VK_VOLUME_MUTE = 0xAD: press and release.
[PaKey]::keybd_event(0xAD, 0, 0, [UIntPtr]::Zero)
[PaKey]::keybd_event(0xAD, 0, 2, [UIntPtr]::Zero)`);
  await new Promise((r) => setTimeout(r, 200));
  return getVolume();
}

/** Lock the workstation. It is the user's own PC and they asked for it. */
export async function lockScreen(): Promise<void> {
  await ps(`rundll32.exe user32.dll,LockWorkStation`, 10_000);
}

/**
 * Play an audio file out of the speakers, at a chosen volume.
 *
 * This is what makes "send me that audio and let me hear it on the PC" work, and the
 * two halves are separate on purpose: the *system* volume is set first so the sound is
 * genuinely as loud as asked for, and the file itself is played through the Media
 * Control Interface, which is the API Windows has used for this since Windows 95 and
 * which handles mp3, wav and wma without any conversion step.
 *
 * The volume is put back afterwards. "Play it at maximum" is a request about how loud
 * one clip should be, not a request to leave the PC at 100% for the rest of the
 * evening, and a tool that silently changed the user's volume would be the kind of
 * thing they have to notice and undo.
 */
export interface PlaybackResult {
  ok: boolean;
  seconds: number;
  volumeSet: number;
  volumeRestoredTo: number | null;
  restoreStatus: 'not-requested' | 'restored' | 'failed';
  detail: string;
}

export function playbackRestoreText(
  result: Pick<PlaybackResult, 'restoreStatus' | 'volumeRestoredTo'>,
): string {
  if (result.restoreStatus === 'failed')
    return 'No he podido verificar la restauración del volumen. Puede seguir alto; revísalo en el PC.';
  if (result.restoreStatus === 'not-requested') return 'No se solicitó restaurar el volumen.';
  return `He dejado el volumen como estaba (${result.volumeRestoredTo}%).`;
}

/** Motivo cuando /stop corta la reproducción en el PC. */
const STOPPED_DETAIL = 'parado con /stop';

export async function playAudioFile(
  file: string,
  opts: { volume?: number; restoreVolume?: boolean; signal?: AbortSignal } = {},
): Promise<PlaybackResult> {
  const target0 =
    opts.volume === undefined ? 100 : Math.max(0, Math.min(100, Math.trunc(opts.volume)));
  if (opts.signal?.aborted) {
    // /stop antes de empezar: ni se toca el volumen ni se lanza nada.
    return {
      ok: false,
      seconds: 0,
      volumeSet: target0,
      volumeRestoredTo: null,
      restoreStatus: 'not-requested',
      detail: STOPPED_DETAIL,
    };
  }
  const exists = await ps(
    `if (Test-Path -LiteralPath '${file.replace(/'/g, "''")}') { '1' } else { '0' }`,
    10_000,
  );
  if (!exists.trim().startsWith('1')) {
    throw new Error(`no encuentro el fichero de audio: ${file}`);
  }

  const before = await getVolume();
  const target =
    opts.volume === undefined ? 100 : Math.max(0, Math.min(100, Math.trunc(opts.volume)));
  let out: string;
  let restored: number | null = null;
  let restoreStatus: PlaybackResult['restoreStatus'] =
    opts.restoreVolume === false ? 'not-requested' : 'failed';
  try {
    const applied = await setVolume(target);
    if (applied.level !== target)
      throw new Error(`no se pudo verificar el volumen: pedido ${target}, leído ${applied.level}`);

    // MCI takes the file through its extension, so an .ogg would fail: the caller is
    // expected to hand over something Windows can decode (mp3, wav, wma). The error is
    // surfaced rather than swallowed, because "nothing played" is not an acceptable
    // outcome to report as success.
    out = await ps(
      `
if (-not ('PaMci' -as [type])) {
  Add-Type -TypeDefinition 'using System;using System.Text;using System.Runtime.InteropServices;public class PaMci{[DllImport("winmm.dll")]public static extern uint waveOutGetNumDevs();[DllImport("winmm.dll",CharSet=CharSet.Unicode)]public static extern int mciSendString(string c,StringBuilder r,int l,IntPtr h);}'
}
if ([PaMci]::waveOutGetNumDevs() -eq 0) { Write-Output 'no audio output device'; exit }
$alias = 'pa' + [Guid]::NewGuid().ToString('N').Substring(0,8)
$open = [PaMci]::mciSendString('open "' + '${file.replace(/'/g, "''")}' + '" alias ' + $alias, $null, 0, [IntPtr]::Zero)
if ($open -ne 0) { Write-Output ("open failed " + $open); exit }
# 0..1000 on the MCI scale, on top of the system volume we just set.
$volumeResult = [PaMci]::mciSendString('setaudio ' + $alias + ' volume to 1000', $null, 0, [IntPtr]::Zero)
if ($volumeResult -ne 0) { [PaMci]::mciSendString('close ' + $alias, $null, 0, [IntPtr]::Zero) | Out-Null; Write-Output ('volume failed ' + $volumeResult); exit }
$start = Get-Date
$play = [PaMci]::mciSendString('play ' + $alias + ' wait', $null, 0, [IntPtr]::Zero)
$elapsed = [int]((Get-Date) - $start).TotalSeconds
[PaMci]::mciSendString('close ' + $alias, $null, 0, [IntPtr]::Zero) | Out-Null
if ($play -ne 0) { Write-Output ("play failed " + $play); exit }
Write-Output ("played " + $elapsed)
`,
      300_000,
      true,
      opts.signal,
    );
  } catch (err) {
    out = opts.signal?.aborted ? STOPPED_DETAIL : err instanceof Error ? err.message : String(err);
  } finally {
    if (opts.restoreVolume !== false) {
      try {
        const state = await setVolume(before.level);
        if (state.level === before.level) {
          restored = state.level;
          restoreStatus = 'restored';
        } else
          log.warn('audio volume restore could not be verified', {
            wanted: before.level,
            got: state.level,
          });
      } catch (err) {
        log.warn('audio volume restore failed', psErrorSummary(err));
      }
    }
  }

  const played = /played (\d+)/.exec(out);
  const detail = played ? '' : out.trim() || 'MCI no devolvio nada';
  return {
    ok: Boolean(played),
    seconds: played ? Number(played[1]) : 0,
    volumeSet: target,
    volumeRestoredTo: restored,
    restoreStatus,
    detail,
  };
}

/**
 * A compact health read of the machine.
 *
 * Each probe is best-effort and degrades to null rather than failing the whole call:
 * a desktop with no battery must still report free disk, and an unplugged cable must
 * not cost the user the rest of the answer.
 */
export async function systemStatus(): Promise<SystemStatus> {
  const out = await ps(
    `
$battery = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
$os = Get-CimInstance Win32_OperatingSystem
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
  Select-Object -First 1).IPAddress
$online = $false
try { $online = (Test-Connection -ComputerName 1.1.1.1 -Count 1 -Quiet -ErrorAction SilentlyContinue) } catch {}
Write-Output ("B|" + $(if ($battery) { $battery.EstimatedChargeRemaining } else { 'x' }))
Write-Output ("P|" + $(if ($battery) { $battery.BatteryStatus } else { 'x' }))
Write-Output ("D|" + [Math]::Round($disk.FreeSpace / 1GB, 1) + "|" + [Math]::Round($disk.Size / 1GB, 1))
Write-Output ("R|" + [Math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / 1MB, 2) + "|" + [Math]::Round($os.TotalVisibleMemorySize / 1MB, 2))
Write-Output ("N|" + $(if ($online) { '1' } else { '0' }) + "|" + $(if ($ip) { $ip } else { 'x' }))
`,
    25_000,
  );

  const get = (prefix: string): string[] => {
    const line = out.split(/\r?\n/).find((l) => l.startsWith(prefix));
    return line ? line.slice(prefix.length).split('|') : [];
  };
  const num = (s: string | undefined): number | null =>
    s && s !== 'x' && Number.isFinite(Number(s)) ? Number(s) : null;

  return {
    batteryPercent: num(get('B|')[0]),
    // Win32_Battery.BatteryStatus: 1 = descargándose, 4/5 = baja/crítica (sin
    // corriente); 2 = con corriente alterna, 3 = cargada, 6-9 = cargando. «2» es
    // justo el enchufado: leerlo como «con batería» invertía el «(enchufado)».
    onBattery: ['1', '4', '5'].includes(get('P|')[0] ?? ''),
    diskFreeGb: num(get('D|')[0]) ?? 0,
    diskTotalGb: num(get('D|')[1]) ?? 0,
    ramUsedGb: num(get('R|')[0]) ?? 0,
    ramTotalGb: num(get('R|')[1]) ?? 0,
    online: get('N|')[0] === '1',
    localIp: (() => {
      const v = get('N|')[1];
      return v && v !== 'x' ? v : null;
    })(),
  };
}

const Params = Type.Object({
  action: Type.Union([
    Type.Literal('volume'),
    Type.Literal('mute'),
    Type.Literal('lock'),
    Type.Literal('status'),
    Type.Literal('play'),
  ]),
  level: Type.Optional(
    Type.Number({ description: 'For volume: 0-100. Omit to just read the current level.' }),
  ),
  path: Type.Optional(
    Type.String({ description: 'For play: the audio file to send to the speakers.' }),
  ),
  volume: Type.Optional(Type.Number({ description: 'For play: how loud, 0-100. Default 100.' })),
});

export function createSystemTool(): AgentTool<typeof Params> {
  return {
    name: 'system',
    label: 'Sistema',
    description: [
      'Control the computer itself.',
      '',
      'action=volume with level 0-100 sets the volume; without level it reads it.',
      'action=mute toggles mute without losing the volume level.',
      'action=lock locks the screen immediately.',
      'action=status reports battery, free disk, memory, network and the local IP.',
      '',
      'Use this when the user asks to turn the music up or down, silence the PC, lock',
      'the screen, or wants to know how the machine is doing. Volume affects what they',
      'can hear from the speakers right now, including media playing in a visible',
      'browser window.',
    ].join(' '),
    parameters: Params,
    executionMode: 'sequential',
    execute: async (_id, args) => {
      switch (args.action) {
        case 'volume': {
          const level = args.level;
          const state = level === undefined ? await getVolume() : await setVolume(level);
          return {
            content: [
              {
                type: 'text',
                text: state.muted
                  ? 'El volumen esta a 0 (en silencio).'
                  : `Volumen al ${state.level}%.`,
              },
            ],
            details: state,
          };
        }

        case 'mute': {
          const state = await toggleMute();
          return {
            content: [
              {
                type: 'text',
                text: state.muted
                  ? 'Silenciado. El volumen anterior se conserva para cuando lo reanudes.'
                  : `Volumen restaurado al ${state.level}%.`,
              },
            ],
            details: state,
          };
        }

        case 'lock': {
          await lockScreen();
          return {
            content: [{ type: 'text', text: 'Pantalla bloqueada.' }],
            details: { locked: true },
          };
        }

        case 'status': {
          const s = await systemStatus();
          const parts = [
            s.batteryPercent === null
              ? 'Sin bateria (enchufado o sobremesa)'
              : `Bateria ${s.batteryPercent}%${s.onBattery ? '' : ' (enchufado)'}`,
            `Disco: ${s.diskFreeGb} GB libres de ${s.diskTotalGb} GB`,
            `Memoria: ${s.ramUsedGb} GB de ${s.ramTotalGb} GB en uso`,
            s.online
              ? `Internet: ok${s.localIp ? ` (IP local ${s.localIp})` : ''}`
              : 'Internet: SIN CONEXION',
          ];
          return {
            content: [{ type: 'text', text: parts.join('\n') }],
            details: s,
          };
        }

        case 'play': {
          const path = String(args.path ?? '');
          if (!path) throw new Error('la accion play necesita path: el fichero de audio');
          const res = await playAudioFile(path, { volume: args.volume });
          return {
            content: [
              {
                type: 'text',
                text: res.ok
                  ? `Sonado ${res.seconds}s al volumen ${res.volumeSet}%. ` +
                    (res.volumeRestoredTo === null
                      ? 'El volumen se queda donde lo puse.'
                      : `He vuelto a dejar el volumen al ${res.volumeRestoredTo}%.`)
                  : `No he podido reproducirlo: ${res.detail}`,
              },
            ],
            details: res,
          };
        }

        default:
          throw new Error(`accion desconocida: ${String(args.action)}`);
      }
    },
  };
}
