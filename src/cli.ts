import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { FollowupTracker } from './alerts/followups.js';
import { formatApprovalQuestion } from './approval-text.js';
import { ActionLog } from './audit/log.js';
import { KINDLE_VAULT_KEY } from './books/kindle.js';
import { BrowserService } from './browser/service.js';
import {
  cleanForTelegram,
  progressMessage,
  shorten,
  stripVoicePrefix,
} from './channels/formatters.js';
import { QaChannel } from './channels/qa.js';
import { ChannelRegistry } from './channels/registry.js';
import { TelegramChannel } from './channels/telegram.js';
import type { ChannelAudio, Inbound } from './channels/types.js';
import { chatKey } from './channels/types.js';
import { loadConfig } from './config.js';
import type { AgentRunResult } from './core/agent.js';
import { PersonalAgent } from './core/agent.js';
import { THREAD_ALLOW_TOOLS } from './core/toolset.js';
import { parseNatural } from './cron/scheduler.js';
import { buildNowNote } from './datecontext.js';
import { Store } from './db.js';
import { assertNotRunning, installLifecycle } from './lifecycle.js';
import { log } from './log.js';
import { loadAccount as loadMailAccount, sendMail } from './mail/client.js';
import { findCurlImpersonate } from './media/download.js';
import { AudioRecall } from './media/recall.js';
import { InstinctStore } from './memory/instincts.js';
import { detectMemoryWorthy } from './memory/nudges.js';
import type { SessionHit } from './memory/sessions.js';
import { SessionStore } from './memory/sessions.js';
import { MemorySnapshot } from './memory/snapshot.js';
import { WorkstreamStore } from './memory/workstreams.js';
import { MemoryStore } from './memory.js';
import { OpenGymError } from './opengym/client.js';
import { makeOpenGymClient, NOT_CONFIGURED, pairOpenGym } from './opengym/setup.js';
import { ensureDirs, paths } from './paths.js';
import { BROWSER_FREE_ACTIONS, Gate } from './permissions.js';
import { DESKTOP_OFF_MESSAGE, DESKTOP_ONLY_TOOLS, desktopEnabled } from './platform.js';
import { procedurePrompt, RoutineRunner, summarizeRoutine, validateSchedule } from './routines.js';
import {
  captureCameraFrame,
  consumeRecording,
  listCaptureDevices,
  recordCamera,
  recordCameraWithMic,
  recordMicrophone,
  toPlayableAudio,
} from './screen/media.js';
import { ocrAvailable } from './screen/ocr.js';
import { ffmpegAvailable, recordScreen } from './screen/recorder.js';
import { WindowsScreen } from './screen/windows.js';
import { recordLessons, skillsIndex } from './skills/lessons.js';
import { SkillStore } from './skills/store.js';
import { formatStatus, summarizeLog } from './status.js';
import { createBookTool } from './tools/book.js';
import { createBrowserTool } from './tools/browser.js';
import { createCalendarTool } from './tools/calendar.js';
import { createComputerTool } from './tools/computer.js';
import { createDoneTool } from './tools/done.js';
import { createDownloadTool } from './tools/download.js';
import { createFetchTool, isFetchableResolved } from './tools/fetch.js';
import { fsTools } from './tools/fs.js';
import { createMediaTool } from './tools/media.js';
import { createMemoryTool } from './tools/memory.js';
import { createOcrTool } from './tools/ocr.js';
import { createOpenGymTool, type GymKind, gymAnswer } from './tools/opengym.js';
import { createRenfeTool } from './tools/renfe.js';
import { createShellTool } from './tools/shell.js';
import { createSkillsTool } from './tools/skills.js';
import { createSystemTool, playAudioFile } from './tools/system.js';
import { createWindowsTool, listWindows } from './tools/windows.js';
import { Mutex } from './utils.js';
import {
  initVault,
  unlock,
  vaultDelete,
  vaultExists,
  vaultGet,
  vaultList,
  vaultSet,
} from './vault.js';
import { transcribeVoiceNote } from './voice/stt.js';
import { createSapiTts } from './voice/tts.js';
import { stripWakeWord, WakeWordListener } from './voice/wake.js';
import { describeChange, PageWatchStore, parseVigilaArgs } from './watch/pages.js';
import { buildWeeklySummary, isWeeklyDue, WeeklyState } from './weekly.js';

const USAGE = `personal-agent - a personal agent for your own PC

Usage:
  pa serve                run the daemon: Telegram, with approvals over chat
  pa chat                 talk to the agent in the console
  pa run "<prompt>"       run one prompt unattended (read-only tools, no prompts)
  pa vault init           create the encrypted secret store
  pa vault set <k> <v>    store a secret
  pa vault get <k>        print one secret
  pa vault list           list secret names (never values)
  pa vault rm <k>         delete a secret
  pa opengym pair [url] <code>   pair openGym (read-only gym tracker)
  pa opengym status       check the openGym connection
  pa doctor               check the environment
`;

/**
 * How long the wake-word listener stays deaf while audio comes out of the speakers.
 *
 * Generous on purpose. A three-minute song played through the same microphone the
 * listener watches would wake on the song's own chorus, and an agent that talks back
 * at itself is worse than one that ignores a wake word. The listener drops the audio
 * it captures while suppressed rather than transcribing it, so the cost of overshooting
 * is a slightly later wake, not a wrong one.
 */
const PLAYBACK_SUPPRESS_MS = 5 * 60_000;

/** A little longer than that, to cover the tail of the file and the daemon's own chatter. */
const WAKE_TAIL_MS = 2_000;

export async function main(argv: string[]): Promise<number> {
  const [command = 'chat', ...rest] = argv;

  switch (command) {
    case 'vault':
      return vaultCommand(rest);
    case 'opengym':
      return openGymCommand(rest);
    case 'doctor':
      return doctorCommand();
    case 'chat':
      return chatCommand();
    case 'serve':
      return serveCommand();
    case 'run':
      return runCommand(rest.join(' '));
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`unknown command ${command}\n\n${USAGE}`);
      return 2;
  }
}

async function openGymCommand(args: string[]): Promise<number> {
  ensureDirs();
  const [sub, a, b] = args;
  try {
    if (sub === 'pair') {
      const code = b ?? a;
      if (!code) {
        process.stderr.write('uso: pa opengym pair [url] <código de 8 caracteres>\n');
        return 2;
      }
      const host = await pairOpenGym(b ? a : undefined, code);
      process.stdout.write(
        `openGym emparejado (código canjeado en ${host}). El token está en el vault (opengym:token).\n`,
      );
      return 0;
    }
    if (sub === 'status') {
      const client = await makeOpenGymClient();
      if (!client) {
        process.stdout.write(`${NOT_CONFIGURED}\n`);
        return 1;
      }
      const { state, rev } = await client.getState();
      process.stdout.write(
        state
          ? `conectado a openGym (revisión ${rev})\n`
          : 'conectado, pero sin datos sincronizados\n',
      );
      return 0;
    }
  } catch (err) {
    process.stderr.write(`${err instanceof OpenGymError ? err.message : String(err)}\n`);
    return 1;
  }
  process.stderr.write('uso: pa opengym pair [url] <código> | pa opengym status\n');
  return 2;
}

async function vaultCommand(args: string[]): Promise<number> {
  ensureDirs();
  const [sub, key, value] = args;

  if (sub === 'init') {
    await initVault();
    process.stdout.write(`vault created at ${paths.vault}\n`);
    return 0;
  }
  if (sub === 'set') {
    if (!key || value === undefined) {
      process.stderr.write('usage: pa vault set <key> <value>\n');
      return 2;
    }
    await vaultSet(key, value);
    process.stdout.write(`stored ${key}\n`);
    return 0;
  }
  if (sub === 'get') {
    if (!key) {
      process.stderr.write('usage: pa vault get <key>\n');
      return 2;
    }
    const v = await vaultGet(key);
    if (v === undefined) {
      process.stderr.write(`no such secret: ${key}\n`);
      return 1;
    }
    process.stdout.write(`${v}\n`);
    return 0;
  }
  if (sub === 'list') {
    for (const k of await vaultList()) process.stdout.write(`${k}\n`);
    return 0;
  }
  if (sub === 'rm') {
    if (!key) {
      process.stderr.write('usage: pa vault rm <key>\n');
      return 2;
    }
    const removed = await vaultDelete(key);
    process.stdout.write(removed ? `deleted ${key}\n` : `no such secret: ${key}\n`);
    return removed ? 0 : 1;
  }
  process.stderr.write(USAGE);
  return 2;
}

async function doctorCommand(): Promise<number> {
  ensureDirs();
  const lines: string[] = [];
  lines.push(`node            ${process.version}`);
  lines.push(`state dir       ${paths.state}`);
  lines.push(`vault           ${vaultExists() ? 'present' : 'MISSING (pa vault init)'}`);

  const key = await vaultGet('provider:apiKey').catch(() => undefined);
  const envKey = process.env.OPENCODE_GO_API_KEY ? 'set' : 'unset';
  lines.push(`provider key    ${key ? 'vault' : envKey}`);
  lines.push(
    `shell           ${hasPwsh() ? 'pwsh 7' : 'powershell 5.1 (install pwsh for full syntax)'}`,
  );

  const screen = new WindowsScreen();
  try {
    const size = await screen.screenSize();
    lines.push(`screen          ${size.width}x${size.height}`);
    const shot = await screen.screenshot();
    lines.push(`screenshot      ok (${shot.image.length} bytes, ${shot.width}x${shot.height})`);
  } catch (err) {
    lines.push(`screenshot      FAILED: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await screen.dispose();
  }

  // Screen recording is what makes /watch work, and its absence is invisible until
  // someone asks for a video of their screen.
  lines.push(
    `screen video    ${ffmpegAvailable() ? 'ok (ffmpeg + libx264)' : 'MISSING ffmpeg-static (/watch will not work)'}`,
  );

  // Voice is opt-in at the point of use, so the only useful question is whether the
  // model is already cached. A cold cache means the first voice note pays a download.
  const modelCached = existsSync(join(paths.models, 'onnx-community', 'whisper-base'));
  lines.push(
    `voice stt       ${modelCached ? 'model cached' : 'model not downloaded yet (first voice note downloads it)'}`,
  );
  lines.push(`voice tts       windows SAPI (offline, free)`);

  // Camera and microphone, because "no encuentro ninguna cámara" at the moment the
  // user asks to be filmed is a much worse answer than this line.
  const devices = await listCaptureDevices().catch(() => ({ video: null, audio: null }));
  lines.push(`camera          ${devices.video ?? 'MISSING (/camera will not work)'}`);
  lines.push(`microphone      ${devices.audio ?? 'MISSING (/mic, wake word will not work)'}`);
  lines.push(
    `wake word       ${(await vaultGet('agent:wakeWord'))?.trim() || 'asistenta'} (${
      (await vaultGet('agent:wake')) === 'off' ? 'off' : 'on'
    })`,
  );

  const chromiumDir = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  lines.push(
    `browser         ${existsSync(chromiumDir) ? 'chromium installed' : 'MISSING (run: npx playwright install chromium)'}`,
  );
  lines.push(`cron            ${loadConfig().cron.length} schedule(s) from PA_CRON`);
  lines.push(
    `verify actions  ${loadConfig().verifyActions ? 'on (2 extra screenshots per input action)' : 'off'}`,
  );

  const windows = await listWindows().catch(() => []);
  lines.push(
    `open windows    ${windows.length ? windows.map((w) => w.title).join(' | ') : 'none detected'}`,
  );

  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

function hasPwsh(): boolean {
  return (
    existsSync(`${process.env.USERPROFILE}\\.local\\pwsh\\pwsh.exe`) ||
    existsSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
  );
}

/**
 * The vertical slice: one agent, console input, gate armed, tools registered.
 * Everything else (channels, scheduler) plugs in behind this same shape.
 */
async function chatCommand(): Promise<number> {
  ensureDirs();
  const config = loadConfig();

  if (!vaultExists()) {
    process.stderr.write('no vault yet. run: pa vault init\n');
    return 1;
  }
  await unlock();

  // Refuse to run twice: a second instance sharing channel credentials gets logged out.
  assertNotRunning(paths.state, 'agent');

  const store = new Store();
  store.sweepExpired();

  const gate = new Gate({
    allow: ['read', 'list', 'fetch', 'done'],
    // Reading the screen and reading a public web page are not changes to the world, so
    // approval. Acting on it does.
    allowActions: ['computer:screenshot', 'computer:move'],
    protectedPaths: [
      `${process.env.USERPROFILE}\\.ssh`,
      `${process.env.USERPROFILE}\\.aws`,
      'C:\\Windows\\System32',
    ],
    maxAmountCents: 30_000,
    // Console mode has a human at the keyboard, so asking is always possible.
    approver: async (call, reason) => {
      const answer = await askYesNo(`allow ${call.tool}? (${reason})`);
      return answer;
    },
  });

  const screen = new WindowsScreen();
  // The session every approval is scoped to. The computer tool's batch gate must
  // use the SAME session the agent below is created with, or a batch's sub-actions
  // would miss the approvals and grant windows the outer call already earned. With
  // no gate at all the batch fails closed and runs nothing, which is exactly the
  // bug this wiring prevents.
  const sessionId = 'local';
  const tools: AgentTool[] = [
    ...fsTools,
    createFetchTool(),
    createDoneTool(),
    createShellTool(config),
    createComputerTool(config, screen, (call) =>
      gate.check(sessionId, { ...call, actor: 'asistenta' }),
    ),
  ] as AgentTool[];

  const agent = await PersonalAgent.create(config, tools, gate, 'local', { sessionId });

  const lifecycle = installLifecycle({
    name: 'agent',
    onShutdown: async () => {
      await screen.dispose();
      store.close();
      log.info('shutdown complete');
    },
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  rl.prompt();

  for await (const line of rl) {
    const text = line.trim();
    if (text === '/quit' || text === '/exit') break;
    if (!text) {
      rl.prompt();
      continue;
    }
    try {
      const result = await agent.run(text);
      log.info('turn done', {
        tools: result.toolCalls,
        blocked: result.blocked,
        stopReason: result.stopReason,
        error: result.error,
      });
    } catch (err) {
      log.error('turn threw', { err });
    }
    rl.prompt();
  }

  rl.close();
  lifecycle.stop('stdin-closed');
  await lifecycle.done;
  return 0;
}

async function askYesNo(question: string): Promise<boolean> {
  const { createInterface } = await import('node:readline');
  process.stdout.write(`${question} [y/N] `);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((r) => rl.question('', r));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function runCommand(prompt: string): Promise<number> {
  if (!prompt.trim()) {
    process.stderr.write('usage: pa run "<prompt>"\n');
    return 2;
  }
  ensureDirs();
  const config = loadConfig();
  if (!vaultExists()) {
    process.stderr.write('no vault yet. run: pa vault init\n');
    return 1;
  }
  await unlock();

  const store = new Store();
  const gate = new Gate({
    allow: ['read', 'list', 'fetch', 'done'],
    // Reading the screen and reading a public web page are not changes to the world, so
    // approval. Acting on it does.
    allowActions: ['computer:screenshot', 'computer:move'],
    protectedPaths: [
      `${process.env.USERPROFILE}\\.ssh`,
      `${process.env.USERPROFILE}\\.aws`,
      'C:\\Windows\\System32',
    ],
    maxAmountCents: 30_000,
    // Unattended one-shot run: there is no human at the keyboard, so anything that
    // would need approval is refused rather than guessed at. Screenshot and read
    // stay available, which is enough for reconnaissance without letting the agent
    // change anything.
    approver: undefined,
  });
  const screen = new WindowsScreen();
  // Same wiring as chatCommand: the batch gate has to share the agent's session so
  // sub-actions see the same decisions, and an unwired gate blocks every batch.
  const sessionId = 'run';
  const tools = [
    ...fsTools,
    createFetchTool(),
    createDoneTool(),
    createShellTool(config),
    createComputerTool(config, screen, (call) =>
      gate.check(sessionId, { ...call, actor: 'asistenta' }),
    ),
  ] as AgentTool[];

  const agent = await PersonalAgent.create(config, tools, gate, 'local', { sessionId });
  const result = await agent.run(prompt);

  // The final answer goes to stdout as plain text so `pa run` is usable in a
  // pipeline; the JSON log lines above it are the machine-readable channel.
  if (result.text.trim()) process.stdout.write(`${result.text.trim()}\n`);
  if (result.error) {
    process.stderr.write(`run failed: ${result.error}\n`);
  }

  await screen.dispose();
  store.close();
  return result.error ? 1 : 0;
}

/**
 * The daemon.
 *
 * One agent per authorised chat, kept in a map keyed by chat. That matters for two
 * reasons: each chat has its own conversation history, and the gate's "approved
 * once" memo is scoped per session, so approving a click in one chat never carries
 * over to another.
 *
 * Serialised per chat. Two turns running concurrently in the same conversation
 * would interleave tool calls against the same desktop cursor, which is exactly how
 * an agent ends up clicking something it did not mean to.
 */
/**
 * One conversation inside one chat.
 *
 * This is the type that makes "drop three unrelated things and get three answers"
 * possible. A thread owns its own agent, its own gate, its own memory scope and its
 * own browser profile, so nothing leaks sideways: an approval in one does not apply to
 * another, and the transcript of one is not the context of another.
 */
interface Thread {
  /** Stable key: chatKey + '#' + name. Also the browser profile and memory scope. */
  key: string;
  chatKey: string;
  name: string;
  agent: PersonalAgent;
  gate: Gate;
  /** Serialises turns inside this thread only. Threads run in parallel. */
  tail: Promise<unknown>;
  /** Bumped by /stop so a cancelled turn can tell it was cancelled. */
  generation: number;
  /** True while a turn is executing, not merely queued. */
  active: boolean;
  /** Short label shown by /topics. */
  label: string;
  createdAt: number;
}

/**
 * Commands handled by the daemon itself rather than by the model.
 *
 * Parsed here, not in the adapter, because every one of them needs process state
 * (the screen backend, the store, the thread map) that the transport must not know
 * about. `null` means "not a command", and the text is then a normal message.
 */
interface ParsedCommand {
  name: string;
  args: string;
}

/**
 * A short, low-content message is a follow-up, not a new task.
 *
 * This one heuristic is what makes the automatic threading usable. Without it, every
 * message would start its own conversation and "sí" would arrive with no context at
 * all. With it, "sí", "vale", "ahora hazlo" continue the conversation already in
 * progress, while anything with real content becomes its own thread when one is
 * already busy.
 *
 * It is a heuristic and that is stated plainly: a user who sends a bare "sí" as a
 * new standalone request gets it attached to the previous thread, which is the
 * behaviour they wanted anyway.
 */
export function looksLikeFollowUp(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return true;
  if (t.length > 16) return false;
  if (/[?¿!]/.test(t)) return false;
  return /^(s[ií]|si|sip|ok|okay|vale|claro|perfecto|hecho|listo|dale|adelante|sigue|contin[uú]a|ahora|nada|mismo|tambien|tambi[eé]n|bien|yes|yeah)[\s.,!]*$/i.test(
    t,
  );
}

export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  // Telegram appends @botname to commands in groups; the name is not part of the
  // command, so it is stripped before anything else looks at the text.
  const withoutSuffix = trimmed.replace(/^(\/\w+)@\w+/, '$1');
  const space = withoutSuffix.indexOf(' ');
  const name = (space < 0 ? withoutSuffix : withoutSuffix.slice(0, space)).slice(1).toLowerCase();
  if (!/^[a-z_]{1,32}$/.test(name)) return null;
  return { name, args: space < 0 ? '' : withoutSuffix.slice(space + 1).trim() };
}

/**
 * The daemon.
 *
 * Conversations are threads, not chats. The user can drop several independent
 * requests and each is answered in its own context, quoting the message it answers,
 * which is the whole point: a chat-scoped agent can only ever hold one conversation,
 * so a second request either contaminates the first or waits behind it.
 *
 * Two ordering rules, and the difference matters:
 *
 * - Turns inside one thread are serialised, so a conversation never talks over
 *   itself.
 * - Turns in *different* threads run concurrently, but every tool that touches the
 *   machine (mouse, keyboard, shell, browser, writes) runs under one mutex. There is
 *   exactly one cursor and one screen, so two conversations may think at the same
 *   time but may never act at the same time.
 */
async function serveCommand(): Promise<number> {
  ensureDirs();
  const config = loadConfig();
  const desktop = desktopEnabled();
  if (!desktop) log.info('modo servidor: herramientas de escritorio Windows desactivadas');
  if (!vaultExists()) {
    process.stderr.write('no vault yet. run: pa vault init\n');
    return 1;
  }
  await unlock();

  const token = await vaultGet('telegram:botToken');
  if (!token) {
    process.stderr.write('no telegram token. run: pa vault set telegram:botToken <token>\n');
    return 1;
  }

  const allowed = (await vaultGet('telegram:allowedUserIds'))
    ?.split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!allowed?.length) {
    process.stderr.write('no allowed users. run: pa vault set telegram:allowedUserIds <id1,id2>\n');
    return 1;
  }

  assertNotRunning(paths.state, 'agent');
  const store = new Store();
  store.sweepExpired();
  const memory = new MemoryStore();

  /**
   * Episodic memory, instincts, workstreams and follow-ups share one SQLite file,
   * separate from the transcript `Store` owns.
   *
   * Separate because both `Store` and `SessionStore` define a table called
   * `sessions` with different columns and neither can be edited here: on one
   * connection the second `CREATE TABLE IF NOT EXISTS` silently no-ops and every
   * write then fails on a missing column. Two files, two schemas, no collision.
   * WAL so the four stores can share the one connection without locking each
   * other out mid-turn.
   */
  const memoryDb = new DatabaseSync(join(paths.state, 'memory.db'));
  memoryDb.exec('PRAGMA journal_mode = WAL');
  memoryDb.exec('PRAGMA busy_timeout = 5000');
  const sessions = new SessionStore({ db: memoryDb });
  const instincts = new InstinctStore({ db: memoryDb });
  const workstreams = new WorkstreamStore({ db: memoryDb });
  const followups = new FollowupTracker({ db: memoryDb });
  const pageWatches = new PageWatchStore(memoryDb);
  const weeklyState = new WeeklyState(memoryDb);
  // One sweep at boot: patterns the user stopped showing lose their weight and
  // the ones that hit zero go, so old accidents cannot steer the daemon forever.
  instincts.decay(90);

  /**
   * The durable memory the model is shown at the start of every turn.
   *
   * Frozen on disk rather than assembled per message: a person should not have to
   * re-explain who they are every morning, and a snapshot costs one read instead of
   * rebuilding the same context from scattered rows each time.
   */
  const snapshot = new MemorySnapshot({ dir: join(paths.state, 'snapshot') });
  const skills = new SkillStore({ dir: join(paths.state, 'skills') });
  const actions = new ActionLog({ file: join(paths.state, 'actions.jsonl') });

  // Canal de QA solo en la sandbox (PA_QA_CHANNEL=1): mismo pipeline, entrada y salida por ficheros.
  const telegram: TelegramChannel =
    process.env.PA_QA_CHANNEL === '1'
      ? new QaChannel({ token, allowedUserIds: allowed, dir: join(paths.state, 'qa') })
      : new TelegramChannel({ token, allowedUserIds: allowed });

  /** Estado de openGym (solo lectura). Lanza OpenGymError con el motivo si no se puede. */
  const gymDeps = {
    load: async () => {
      const client = await makeOpenGymClient();
      if (!client) throw new OpenGymError('config', NOT_CONFIGURED);
      return (await client.getState()).state;
    },
  };
  const registry = new ChannelRegistry();
  registry.register(telegram);

  const screen = new WindowsScreen();
  const tts = createSapiTts();

  /**
   * One mutex for everything that moves the machine. Reasoning runs outside it;
   * acting does not. A 90-second browser task therefore no longer blocks the user
   * from asking a second question that only needs a sentence.
   */
  const machine = new Mutex();

  const fullControl = (await vaultGet('agent:fullControl')) === 'true';
  const ocrAvailability = desktop ? await ocrAvailable().catch(() => false) : false;
  const voiceDefault = (await vaultGet('agent:voice')) !== 'off';

  /**
   * What the user sent us, kept only as Telegram handles.
   *
   * A voice note is transcribed and then, before this existed, thrown away. Two
   * messages later "suéltame ese audio" had nothing to act on. `file_id`s stay
   * downloadable, so remembering the handle is enough to play the audio again
   * without keeping a copy of someone's voice on disk longer than the chat needs.
   */
  const recall = new AudioRecall();

  /**
   * The most recent chat that spoke.
   *
   * The wake word arrives with no chat attached - it is audio from a room, not a
   * message - so it has to be answered somewhere. Whoever talked last is the only
   * defensible guess: the daemon only serves allowed users, and answering a wake
   * word into whatever chat happened to be last is what "always on" means.
   */
  let lastChat: { key: string; chatId: string; threadId?: string } | null = null;

  /**
   * Wake word listener. Null until it is built (it is created after the turn
   * machinery it calls exists) and again after `/wake off`.
   */
  let wake: WakeWordListener | null = null;
  let wakeWanted = desktop && (await vaultGet('agent:wake')) !== 'off';
  const wakeWord = (await vaultGet('agent:wakeWord'))?.trim() || 'asistenta';

  /**
   * The live listener, or null.
   *
   * A function rather than the variable because the listener is only ever assigned
   * from inside the closures that start and stop it, and the compiler's flow analysis
   * would narrow the variable to `null` at every point in `serveCommand` that runs
   * before those closures exist. Reading it through a call keeps the type honest
   * instead of `as`-ing it away.
   */
  const currentWake = (): WakeWordListener | null => wake;

  /**
   * Run a body with the microphone handed over.
   *
   * The wake listener holds the capture device open continuously, which is the whole
   * point of it and also exactly what stops a second recorder from opening. Anything
   * that wants the microphone is given a turn: the listener is stopped, the body runs,
   * and it comes back afterwards. Stopping rather than merely suppressing matters,
   * because suppression drops audio but keeps the device claimed.
   */
  const withMicrophone = async <T>(fn: () => Promise<T>): Promise<T> => {
    const listener = wake;
    const wasRunning = listener?.isRunning() ?? false;
    if (wasRunning) await listener?.stop().catch(() => {});
    try {
      return await fn();
    } finally {
      if (wasRunning) {
        await listener
          ?.start()
          .catch((err: unknown) => log.warn('wake listener did not restart', { err }));
      }
    }
  };

  /**
   * Browser sessions are per thread, because a persistent profile carries cookies.
   * One browser shared between conversations would let a logged-in session in one
   * thread be visible in another.
   */
  const browsers = new Map<string, BrowserService>();
  const browserFor = (threadKey: string): BrowserService => {
    const existing = browsers.get(threadKey);
    if (existing) return existing;
    const service = new BrowserService({
      policy: {
        // Full control has to reach the browser's own approval layer, not just the
        // gate. The gate allowed every `browser` call and the user was still asked to
        // approve youtube.com, because domain consent was a second, separate prompt
        // the agent could not talk past. Same decision, both layers.
        autoApprove: fullControl,
        // Approval for a domain goes to the chat that asked for it, through the same
        // inline buttons as any other gated action.
        approve: async (scope, domain, reason) => {
          const chatId = scope.split('#')[0]?.split(':')[2] ?? '';
          log.info('browser domain approval requested', { domain, chatId });
          // "Siempre" is the right answer for a site the user has already named: the
          // domain is remembered across restarts, so the next visit is silent.
          const choice = await telegram.offerApproval(
            randomUUID(),
            chatId,
            `¿Abro ${domain}?\n${reason}`,
            { askScope: true },
          );
          return choice.approved;
        },
      },
      timeoutMs: Math.min(config.toolTimeoutMs, 60_000),
      channel: config.browserChannel,
    });
    browsers.set(threadKey, service);
    return service;
  };

  const threads = new Map<string, Thread>();
  /** `${chatKey}:${messageId}` -> thread key, so a reply lands in its conversation. */
  const messageThread = new Map<string, string>();

  /**
   * Retire conversations nobody has used for a while.
   *
   * Each thread holds a live agent with a full transcript and its own browser profile,
   * so an always-on daemon that creates a thread per dropped message grows without
   * bound: memory climbs all day and the daemon eventually slows down. Twenty is
   * generous for one person (they would have to have twenty separate subjects going),
   * and eviction is last-touched-first so the current conversation is never the one
   * dropped.
   *
   * Memory, routines and the browser profile survive eviction on disk; only the
   * in-memory agent goes, so returning to an old conversation restores it with its
   * notes and its logged-in session still in place.
   */
  const MAX_THREADS = 20;
  const evictIdleThreads = (): void => {
    if (threads.size <= MAX_THREADS) return;
    const idle = [...threads.values()]
      .filter((t) => !t.active && t.name !== activeTopic.get(t.chatKey))
      .sort((a, b) => a.createdAt - b.createdAt);
    while (threads.size > MAX_THREADS && idle.length) {
      const victim = idle.shift();
      if (!victim) break;
      threads.delete(victim.key);
      // The browser profile stays on disk on purpose; only the live Chromium goes.
      const service = browsers.get(victim.key);
      if (service) {
        void service.closeAll().catch(() => {});
        browsers.delete(victim.key);
      }
      log.info('thread evicted', { thread: victim.key, remaining: threads.size });
    }
  };
  /** chatKey -> explicitly selected thread name, set by /topic. */
  const activeTopic = new Map<string, string>();
  /** chatId -> thread currently recording steps for /learn. */
  const learning = new Map<string, string>();
  /** chatId -> whether to answer with a spoken reply. */
  const voiceOn = new Map<string, boolean>();
  /** chatId -> whether to send periodic progress notes. Off = one message at the end. */
  const statusOn = new Map<string, boolean>();
  /** chatId -> running watch loop, so /watch can be started and stopped once. */
  const watching = new Map<string, Promise<void>>();
  /** chatId -> the live view refreshing one photo in place. */
  const liveViews = new Map<string, { timer: NodeJS.Timeout; messageId: string }>();
  const seenMessages = new Map<string, number>();

  /**
   * The message a thread is currently answering.
   *
   * A thread outlives any single message, so a tool that has to send something back
   * to the chat (a photo, a clip, a live view) needs to know which message to quote.
   * Recorded per turn in `runTurn`; the fallback is used only by a live view started
   * from a tool call, where quoting the current turn's message is the right guess.
   */
  const threadInbound = new Map<string, Inbound>();

  const inboundFor = (thread: Thread): Inbound => {
    const live = threadInbound.get(thread.key);
    if (live) return live;
    const [channel, account, chatId, threadId] = thread.chatKey.split(':');
    return {
      channel: channel ?? 'telegram',
      account: account ?? telegram.account,
      chatId: chatId ?? '',
      threadId: threadId || undefined,
      userId: '',
      text: '',
      authorised: true,
      messageId: `${thread.key}#tool`,
      receivedAt: new Date().toISOString(),
    };
  };

  const threadTools = (thread: Thread): AgentTool[] => {
    const scope = () => thread.key;
    const all: AgentTool[] = [
      ...fsTools,
      createFetchTool(),
      createRenfeTool(),
      createDoneTool(),
      createShellTool(config),
      // Each thread has its own gate and its own session key, so batch sub-actions
      // are policed by THIS conversation's approvals and an unwired gate never
      // silently blocks every batch.
      createComputerTool(config, screen, (call) =>
        thread.gate.check(thread.key, { ...call, actor: 'asistenta' }),
      ),
      createBrowserTool(browserFor(thread.key), scope, (png) =>
        telegram
          .sendPhotoBytes(Number(thread.chatKey.split(':')[2]), png, inboundFor(thread).threadId)
          .then(() => true),
      ),
      // The durable memory plus the model's own procedural skills. The snapshot is
      // what makes the model stop asking who the user is; the skills are what make it
      // stop re-deriving a procedure it already worked out.
      createMemoryTool(memory, scope, snapshot),
      createSkillsTool({ store: skills }),
      // Window and UI Automation inspection. Read-only, so it is not under the
      // machine mutex: two conversations may both look at the window list at once.
      createWindowsTool(),
      // Reading the screen as text: the vision model cannot always read what it sees,
      // and a control name it cannot read is a control it cannot click.
      createOcrTool({
        screenshotToFile: async () => {
          const shot = await screen.screenshot();
          const file = join(paths.voice, `ocr-${Date.now()}.jpg`);
          writeFileSync(file, shot.image);
          return file;
        },
        // Cached once per process: asking Windows whether it has an OCR engine costs a
        // PowerShell round trip, and the answer does not change while we run.
        ocrAvailable: async () => ocrAvailability,
      }),
      // What is in the calendar. Free, read-only and stale by design; see the tool.
      createCalendarTool({
        getUrl: () => vaultGet('calendar:icsUrl'),
        fetchText: async (url) => {
          const res = await fetch(url, { redirect: 'follow' });
          if (!res.ok) throw new Error(`el calendario ha respondido ${res.status}`);
          return res.text();
        },
      }),
      // The machine itself: volume, mute, lock, and how it is doing.
      createSystemTool(),
      // "Descarga este vídeo / pásame este PDF" with a link: yt-dlp for video sites, a
      // direct fetch for PDFs, sent back to the chat as MP4 or document.
      // Free and public-domain books (Gutenberg, Internet Archive): search, download as
      // EPUB, send to this chat and/or to the user's Kindle by email (approval each time).
      createBookTool({
        sendDocument: (bytes, filename, caption) =>
          telegram
            .sendDocumentBytes(
              Number(thread.chatKey.split(':')[2]),
              bytes,
              filename,
              caption,
              inboundFor(thread).threadId,
            )
            .then(() => true),
        saveKindleAddress: (address) => vaultSet(KINDLE_VAULT_KEY, address),
        kindle: {
          getAddress: async () => (await vaultGet(KINDLE_VAULT_KEY)) ?? null,
          loadAccount: loadMailAccount,
          send: sendMail,
          requireApproval: async (_action, summary) => {
            const choice = await telegram.offerApproval(
              randomUUID(),
              thread.chatKey.split(':')[2] ?? '',
              `¿${summary}?`,
            );
            return choice.approved;
          },
        },
      }),
      createDownloadTool({
        onResult: (r) =>
          actions.record({
            actor: 'asistenta',
            action: 'descarga',
            target: r.host,
            result: r.ok ? 'ok' : 'error',
            detail: r.ok ? r.kind : r.reason,
          }),
        sendVideo: (bytes, seconds, label) =>
          telegram
            .sendVideo(Number(thread.chatKey.split(':')[2]), bytes, seconds, label)
            .then(() => true),
        sendDocument: (bytes, filename, caption) =>
          telegram
            .sendDocumentBytes(
              Number(thread.chatKey.split(':')[2]),
              bytes,
              filename,
              caption,
              inboundFor(thread).threadId,
            )
            .then(() => true),
        progress: (what) => telegram.action(inboundFor(thread).chatId, what),
        options: {
          cookiesFromBrowser: config.downloadCookiesBrowser,
          curlImpersonatePath: config.curlImpersonatePath,
        },
      }),
      // Audio, camera and microphone in ordinary language. Everything here is also a
      // slash command; the tool exists for "suéltame ese audio" and "grábame con mi
      // voz", which are requests about an attachment rather than commands.
      createOpenGymTool(gymDeps),
      createMediaTool({
        chatKey: thread.key,
        recall,
        downloadAudio: (fileId, limitBytes) => telegram.downloadFile(fileId, limitBytes),
        chatId: thread.chatKey.split(':')[2] ?? '',
        maxEdge: config.screenshotMaxEdge,
        // Telegram's photo sender wants both dimensions together, and a caller that
        // knows neither has nothing useful to say about the size anyway.
        sendPhoto: (bytes, opts) => {
          const chatId = Number(thread.chatKey.split(':')[2]);
          const threadId = inboundFor(thread).threadId;
          return opts?.width !== undefined && opts.height !== undefined
            ? telegram.sendPhotoBytes(chatId, bytes, threadId, {
                width: opts.width,
                height: opts.height,
              })
            : telegram.sendPhotoBytes(chatId, bytes, threadId);
        },
        sendVideo: (bytes, seconds, label) =>
          telegram
            .sendVideo(Number(thread.chatKey.split(':')[2]), bytes, seconds, label)
            .then(() => true),
        sendVoice: (bytes, seconds) =>
          telegram
            .sendVoiceBytes(
              Number(thread.chatKey.split(':')[2]),
              bytes,
              inboundFor(thread).threadId,
              seconds,
            )
            .then(() => true),
        progress: (what) => telegram.action(inboundFor(thread).chatId, what),
        live: {
          start: (source, intervalSeconds) =>
            startLiveViewFromThread(thread, source, intervalSeconds * 1000),
          stop: () => stopLiveViewFromThread(thread),
        },
        withMicrophone,
        // The speakers are the microphone's other half. Quieten the listener before
        // the sound comes out or the agent answers its own playback.
        beforePlayback: () => currentWake()?.suppress(PLAYBACK_SUPPRESS_MS),
        afterPlayback: () => currentWake()?.suppress(WAKE_TAIL_MS),
      }),
    ] as AgentTool[];

    // Only the tools that move the machine take the mutex. Wrapping read-only tools
    // would throw away the parallelism that makes multiple conversations worth having.
    const exclusive = new Set(['computer', 'shell', 'browser', 'write', 'media']);
    const raw = desktop ? all : all.filter((tool) => !DESKTOP_ONLY_TOOLS.has(tool.name));
    return raw.map((tool): AgentTool => {
      if (!exclusive.has(tool.name)) return tool;
      const inner = tool.execute.bind(tool);
      return {
        ...tool,
        execute: (id, params, signal, onUpdate) =>
          machine.run(() => inner(id, params, signal, onUpdate)),
      };
    });
  };

  /**
   * One gate per conversation, because approval scope is per conversation: allowing
   * a click in one thread must not let the next thread click without asking.
   *
   * The holder indirection exists because the gate is built before the agent it
   * protects. The approver closure only ever fires inside a tool call, which cannot
   * happen until the agent exists, so the assignment below is safe and a captured
   * variable would only be a source of stale references.
   */
  const gateFor = (
    threadKey: string,
    chatId: string,
    holder: { agent: PersonalAgent | null },
  ): Gate => {
    // Assigned before the approver closes over it. The approver only ever runs
    // inside a tool call, which cannot happen until the gate exists, so reading
    // `gate` from inside it is safe and a holder indirection would only add noise.
    const gate = new Gate({
      // 'opengym' es de solo lectura (no tiene ninguna acción que escriba). El cargador
      // de herramientas solo cambia cuáles se listan; browser/media siguen pasando por
      // el gate una a una.
      allow: THREAD_ALLOW_TOOLS,
      allowActions: [
        'computer:screenshot',
        'computer:move',
        // Navigating and operating a page does not ask: the gate still asks first for
        // money, credential fields and sending/deleting/booking elements, and exec_js
        // (arbitrary code) is not listed.
        ...BROWSER_FREE_ACTIONS,
      ],
      // Full control is opt-in via the vault, never a command-line flag, so it cannot
      // be switched on by a stray script or a leftover shell history entry.
      fullControl,
      protectedPaths: [
        `${process.env.USERPROFILE}\\.ssh`,
        `${process.env.USERPROFILE}\\.aws`,
        'C:\\Windows\\System32',
      ],
      maxAmountCents: 30_000,
      grantWindowMs: 90_000,
      // Approvals travel back over Telegram as inline buttons, and the idle watchdog
      // is paused while one is parked: waiting for a human is not a stall. The buttons
      // also carry the scope: "siempre" must mean always, not once per task.
      approver: async (call, reason) => {
        const id = randomUUID();
        log.info('approval requested', { thread: threadKey, tool: call.tool, reason });
        holder.agent?.setAwaitingApproval(true);
        const question = formatApprovalQuestion(call, reason);
        try {
          const choice = await telegram.offerApproval(id, chatId, question, {
            askScope: true,
          });
          if (choice.approved && choice.scope !== 'once') {
            // Recorded before returning, so the very next call of the same tool in
            // this task is already covered by the decision the user just made.
            gate.setScope(threadKey, call.tool, choice.scope);
          }
          return choice.approved;
        } finally {
          holder.agent?.setAwaitingApproval(false);
        }
      },
    });
    return gate;
  };

  const getOrCreateThread = async (
    chatKey_: string,
    name: string,
    label: string,
  ): Promise<Thread> => {
    const key = `${chatKey_}#${name}`;
    const existing = threads.get(key);
    if (existing) {
      // Touching a thread on use is what keeps the current conversation from being the
      // eviction candidate.
      existing.createdAt = Date.now();
      return existing;
    }
    const holder: { agent: PersonalAgent | null } = { agent: null };
    const gate = gateFor(key, chatKey_.split(':')[2] ?? '', holder);
    const thread: Thread = {
      key,
      chatKey: chatKey_,
      name,
      agent: null as unknown as PersonalAgent,
      gate,
      tail: Promise.resolve(),
      generation: 0,
      active: false,
      label,
      createdAt: Date.now(),
    };
    thread.agent = await PersonalAgent.create(config, threadTools(thread), gate, 'telegram-user', {
      sessionId: key,
      deferTools: true,
    });
    threads.set(key, thread);
    log.info('thread created', { thread: key });
    evictIdleThreads();
    return thread;
  };

  const defaultThread = async (chatKey_: string): Promise<Thread> =>
    getOrCreateThread(chatKey_, 'main', 'principal');

  /**
   * Decide which conversation a message belongs to.
   *
   * Order matters and each step is a real user intent:
   *
   * 1. An explicit `/topic` wins: the user is saying where this goes.
   * 2. A reply to one of our own messages continues that message's conversation.
   *    This is the common case for "and now do X", and it is why every reply we send
   *    is attached to the message it answers.
   * 3. A real Telegram thread id is used as the conversation, so a user who has
   *    topics enabled in the chat gets separate conversations for free.
   * 4. Otherwise: a short acknowledgement continues the main conversation even while
   *    it is busy, and anything with real content starts its own conversation when the
   *    main one is already occupied. That last rule is what lets several tasks be in
   *    flight at once without them mixing.
   */
  const resolveThread = async (inbound: Inbound): Promise<Thread> => {
    const chatKey_ = chatKey(inbound);
    const explicit = activeTopic.get(chatKey_);
    if (explicit) return getOrCreateThread(chatKey_, explicit, explicit);

    if (inbound.replyToMessageId) {
      const mapped = messageThread.get(`${chatKey_}:${inbound.replyToMessageId}`);
      const found = mapped ? threads.get(mapped) : undefined;
      if (found) return found;
    }

    if (inbound.threadId) {
      return getOrCreateThread(chatKey_, `t${inbound.threadId}`, `hilo ${inbound.threadId}`);
    }

    const main = await defaultThread(chatKey_);
    if (!main.active) return main;
    if (looksLikeFollowUp(inbound.text)) return main;

    // Its own conversation, named after the message that started it so the label is
    // traceable. The label shown to the user is a trimmed version of the request.
    const label = inbound.text.trim().slice(0, 40) || 'petición';
    return getOrCreateThread(chatKey_, `m${inbound.messageId}`, label);
  };

  const say = async (
    inbound: Inbound,
    text: string,
    opts: { audio?: ChannelAudio; images?: Inbound['images']; quote?: boolean } = {},
  ): Promise<string | null> => {
    return telegram
      .send({
        channel: 'telegram',
        account: telegram.account,
        chatId: inbound.chatId,
        threadId: inbound.threadId,
        // The answer quotes the message it answers. Without this, three concurrent
        // conversations in one chat are unreadable: you cannot tell which reply
        // belongs to which request.
        replyToMessageId: opts.quote === false ? undefined : inbound.messageId,
        text,
        images: opts.images,
        audio: opts.audio,
      })
      .catch((err: unknown) => {
        log.warn('send failed', { err });
        return null;
      });
  };

  /**
   * Reply with speech when the user spoke. The mirror policy: talking gets a spoken
   * answer, typing gets text. Anything else is noise on a phone speaker.
   *
   * The text is cleaned and bounded before it leaves. Telegram renders markdown
   * headers and tables badly, and a wall of text on a phone is not an answer: the
   * model is asked to be terse in the prompt, and this is the second half of that
   * promise - a reply that runs long is cut at a word and offered in full on request,
   * rather than scrolling past the thing the user asked.
   */
  const answer = async (thread: Thread, inbound: Inbound, text: string): Promise<void> => {
    const wantsVoice = voiceOn.get(inbound.chatId) ?? voiceDefault;
    const cleaned = cleanForTelegram(stripVoicePrefix(text.trim()));
    const short = shorten(cleaned);
    let audio: ChannelAudio | undefined;
    if (desktop && wantsVoice && inbound.audioFileId && text.trim()) {
      try {
        const spoken = await tts.speak(trimForSpeech(text));
        audio = { mimeType: spoken.mimeType, data: spoken.data.toString('base64') };
      } catch (err) {
        log.warn('tts failed, sending text only', { err });
      }
    }
    const id = await say(inbound, short.text, { audio });
    if (id) messageThread.set(`${chatKey(inbound)}:${id}`, thread.key);
    if (short.truncated) {
      log.info('reply shortened', { chars: cleaned.length, thread: thread.name });
    }
  };

  const lifecycle = installLifecycle({
    name: 'agent',
    onShutdown: async () => {
      // Stop acting first: a click mid-flight must not survive the shutdown.
      for (const thread of threads.values()) thread.agent.abort('external');
      telegram.cancelApprovals();
      const pending = [...threads.values()].map((t) => t.tail.catch(() => {}));
      await Promise.race([
        Promise.allSettled(pending),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
      routineRunner.stop();
      // Release the microphone before anything else slow: an ffmpeg that is still
      // holding the capture device would keep the next app (or the next start) from
      // opening it.
      await stopWake().catch(() => {});
      // Every Chromium, or the next start refuses to claim the profile dir.
      await Promise.all([...browsers.values()].map((b) => b.closeAll().catch(() => {})));
      await registry.stopAll();
      await screen.dispose();
      store.close();
      memoryDb.close();
      log.info('daemon stopped', { threads: threads.size });
    },
  });

  const routineRunner = new RoutineRunner({
    store,
    run: async (prompt, ctx) => {
      // A scheduled routine answers into the chat it was learned in. It reuses the
      // thread of that scope when one exists, so the conversation that created the
      // routine also receives its output.
      const [chatPart] = ctx.scope.split('#');
      const chatId = chatPart?.split(':')[2] ?? '';
      if (!chatId) return;
      log.info('routine fired', { routine: ctx.routine.name, chatId });
      await telegram
        .send({
          channel: 'telegram',
          account: telegram.account,
          chatId,
          text: `⏰ Rutina "${ctx.routine.name}":\n\n${prompt}`,
        })
        .catch((err: unknown) => log.warn('routine send failed', { err }));
    },
  });
  routineRunner.start();

  // ---- commands -----------------------------------------------------------

  const cmdScreen = async (inbound: Inbound, args = ''): Promise<void> => {
    if (!desktop) {
      await say(inbound, DESKTOP_OFF_MESSAGE, { quote: true });
      return;
    }
    const sub = args.trim().split(/\s+/)[0] ?? '';
    if (sub === 'live' || sub === 'on') {
      const interval = Math.max(2, Math.min(30, Number(args.trim().split(/\s+/)[1]) || 5));
      await startLiveView(inbound, 'screen', interval * 1000, 15 * 60 * 1000);
      return;
    }
    if (sub === 'off' || sub === 'stop') {
      stopLiveView(inbound.chatId);
      await say(inbound, 'Vista en directo detenida.', { quote: true });
      return;
    }
    await telegram.action(inbound.chatId, 'upload_photo');
    const shot = await screen.screenshot();
    const ok = await telegram
      .sendPhotoBytes(Number(inbound.chatId), shot.image, inbound.threadId, {
        width: shot.width,
        height: shot.height,
      })
      .then(() => true)
      .catch((err: unknown) => {
        log.warn('screen send failed', { err });
        return false;
      });
    await say(
      inbound,
      ok
        ? `Captura de ahora mismo (${shot.width}x${shot.height}).`
        : 'No he podido enviar la captura.',
      { quote: true },
    );
  };

  /**
   * Record and send a clip.
   *
   * A clip rather than a frame stream: Telegram allows about one message per second
   * in a chat and re-encodes photos, so frames would arrive at 1fps with compression
   * artefacts and stay in the chat forever. One video is one message with a player.
   */
  const cmdWatch = async (inbound: Inbound, args: string): Promise<void> => {
    const running = watching.get(inbound.chatId);
    if (running && !args) {
      watching.delete(inbound.chatId);
      await say(inbound, 'Grabación detenida.', { quote: true });
      return;
    }
    const parts = args.split(/\s+/).filter(Boolean);
    const seconds = Math.max(1, Math.min(60, Number(parts[0]) || 20));
    const fps = Math.max(1, Math.min(15, Number(parts[1]) || 8));

    if (running) {
      await say(inbound, 'Ya había una grabación en marcha; espera a que termine.', {
        quote: true,
      });
      return;
    }

    const job = (async () => {
      await say(inbound, `Grabando ${seconds}s⬦`, { quote: true });
      try {
        const recording = await recordScreen({
          seconds,
          fps,
          maxEdge: config.screenshotMaxEdge,
        });
        const bytes = readFileSync(recording.file);
        rmSync(recording.file, { force: true });
        await telegram.sendVideo(Number(inbound.chatId), bytes, seconds, 'Pantalla');
        log.info('watch clip sent', { chatId: inbound.chatId, bytes: bytes.length });
      } catch (err) {
        await say(
          inbound,
          `No he podido grabar: ${err instanceof Error ? err.message : String(err)}`,
          {
            quote: true,
          },
        );
      } finally {
        watching.delete(inbound.chatId);
      }
    })();
    watching.set(inbound.chatId, job);
    await job;
  };

  const cmdTopic = async (inbound: Inbound, args: string): Promise<void> => {
    const chatKey_ = chatKey(inbound);
    const name = args.trim().split(/\s+/)[0] ?? '';
    if (!name) {
      const open = [...threads.values()].filter((t) => t.chatKey === chatKey_);
      const current = activeTopic.get(chatKey_) ?? 'main';
      await say(
        inbound,
        [
          `Conversaciones abiertas: ${open.length}`,
          ...open.map((t) => `- ${t.name}${t.name === current ? ' (activa)' : ''}: ${t.label}`),
          '',
          'Usa /topic <nombre> para abrir una conversación nueva y /topics para verlas.',
        ].join('\n'),
        { quote: true },
      );
      return;
    }
    activeTopic.set(chatKey_, name);
    const thread = await getOrCreateThread(chatKey_, name, name);
    messageThread.set(`${chatKey_}:${inbound.messageId}`, thread.key);
    await say(
      inbound,
      `Conversación "${name}" lista. Lo que escribas va aquí; /topic main vuelve a la principal.`,
      { quote: true },
    );
  };

  const cmdTopics = async (inbound: Inbound): Promise<void> => {
    const chatKey_ = chatKey(inbound);
    const open = [...threads.values()].filter((t) => t.chatKey === chatKey_);
    const current = activeTopic.get(chatKey_);
    await say(
      inbound,
      [
        `Conversaciones en este chat: ${open.length}`,
        ...open.map(
          (t) =>
            `- ${t.name}${t.name === current ? ' (activa)' : ''}${t.active ? ' · trabajando' : ''}: ${t.label}`,
        ),
        '',
        'Responde a cualquiera de mis mensajes para seguir esa conversación.',
      ].join('\n'),
      { quote: true },
    );
  };

  /**
   * Learn a routine.
   *
   * `/learn <name>` starts recording; the user then does the thing once with the agent
   * watching; `/learn end` makes the agent write down the steps. Learning from a
   * demonstration is the only version of "it learns" that is reliable: asking a model
   * to invent steps it never performed produces plausible fiction.
   */
  const cmdLearn = async (thread: Thread, inbound: Inbound, args: string): Promise<void> => {
    const name = args.trim();
    if (name.toLowerCase() === 'end') {
      const recorded = learning.get(inbound.chatId);
      if (!recorded) {
        await say(inbound, 'No estaba grabando ninguna rutina. Empieza con /learn <nombre>.', {
          quote: true,
        });
        return;
      }
      learning.delete(inbound.chatId);
      await say(inbound, 'Resumiendo los pasos que acabas de hacer⬦', { quote: true });
      const transcript = summarizeTranscript(thread.agent.messages);
      const result = await thread.agent.run(
        [
          'Acabas de ayudar al usuario a hacer esta tarea paso a paso:',
          transcript,
          '',
          'Escribe en español los pasos reutilizables, en tercera persona e imperativo breve,',
          'uno por línea, sin numeración ni explicaciones. Empieza por el más general.',
          'Si algún paso requiere una contraseña o un pago, escribe [PIDE CONFIRMACIÓN].',
          'Si no se puede reutilizar, escribe una sola línea: NO REUTILIZABLE.',
          'No escribas nada más: ni título, ni comentarios, ni código fences.',
        ].join('\n'),
      );
      const steps = result.text.trim();
      if (!steps) {
        await say(inbound, 'No he podido resumir los pasos.', { quote: true });
        return;
      }
      const routine = store.saveRoutine({
        scope: thread.key,
        name: recorded,
        kind: 'procedure',
        steps,
      });
      await say(
        inbound,
        [
          `Rutina "${routine.name}" guardada. Replaying con /routine ${routine.name}.`,
          '',
          steps,
        ].join('\n'),
        { quote: true },
      );
      return;
    }
    if (!name) {
      await say(inbound, 'Uso: /learn <nombre> para empezar, /learn end para cerrar.', {
        quote: true,
      });
      return;
    }
    learning.set(inbound.chatId, name);
    await say(
      inbound,
      `Grabando "${name}". Haz la tarea como la harías tú; cuando termines, /learn end.`,
      { quote: true },
    );
  };

  const cmdRoutine = async (thread: Thread, inbound: Inbound, args: string): Promise<void> => {
    const name = args.trim().split(/\s+/)[0] ?? '';
    if (!name) {
      await say(inbound, 'Uso: /routine <nombre>. Mira /routines para la lista.', { quote: true });
      return;
    }
    const routine =
      store.getRoutine(thread.key, name) ?? store.getRoutine(`${thread.chatKey}#main`, name);
    if (!routine) {
      // Not a stored name, so it may be how a person asks for a new one:
      // "/routine cada mañana a las 8 resumen del día". The Spanish schedule in
      // the words becomes a real cron routine instead of "no such routine".
      const parsed = parseNatural(args.trim());
      if (parsed) {
        const created = store.saveRoutine({
          scope: thread.key,
          name: routineNameFromPrompt(parsed.prompt),
          kind: 'schedule',
          prompt: parsed.prompt,
          schedule: parsed.schedule,
        });
        // Live at once: a routine that only fires after a restart is one the user
        // has to remember they asked for.
        routineRunner.sync();
        const live = routineRunner
          .status()
          .find((s) => s.scope === created.scope && s.name === created.name);
        await say(
          inbound,
          [
            `Rutina "${created.name}" programada con horario ${created.schedule}.`,
            `Tarea: ${created.prompt}`,
            `Próxima ejecución: ${nextRunLabel(created.schedule, live?.next)}.`,
            'La ves con /agenda; la repito cuando quieras con /routine.',
          ].join('\n'),
          { quote: true },
        );
        return;
      }
      await say(inbound, `No tengo ninguna rutina llamada "${name}".`, { quote: true });
      return;
    }
    const prompt =
      routine.kind === 'schedule' && routine.prompt ? routine.prompt : procedurePrompt(routine);
    store.markRoutineRun(routine.scope, routine.name);
    messageThread.set(`${chatKey(inbound)}:${inbound.messageId}`, thread.key);
    await runTurn(thread, inbound, prompt, {});
  };

  const cmdRoutines = async (inbound: Inbound): Promise<void> => {
    const chatKey_ = chatKey(inbound);
    const list = store.listRoutines().filter((r) => r.scope.startsWith(chatKey_));
    if (!list.length) {
      await say(inbound, 'Todavía no hay rutinas. Graba una con /learn <nombre>.', {
        quote: true,
      });
      return;
    }
    await say(
      inbound,
      [
        `Rutinas: ${list.length}`,
        ...list.map((r) =>
          [
            `- ${r.name} (${r.kind})${r.schedule ? ` [${r.schedule}]` : ''}`,
            summarizeRoutine(r),
          ].join(': '),
        ),
      ].join('\n'),
      { quote: true },
    );
  };

  /**
   * The scheduled half of the routines, with their next fire.
   *
   * The live runner is the source of truth for "when": it is what will actually
   * fire, held first runs included. The store is the source of truth for what
   * exists, so a routine that failed to register is still listed instead of
   * silently missing from the agenda.
   */
  const cmdAgenda = async (inbound: Inbound): Promise<void> => {
    const chatKey_ = chatKey(inbound);
    const scheduled = store
      .listRoutines()
      .filter((r) => r.scope.startsWith(chatKey_) && r.kind === 'schedule');
    if (!scheduled.length) {
      await say(
        inbound,
        'No hay ninguna rutina programada. Crea una con /routine, por ejemplo: ' +
          '/routine cada mañana a las 8 resumen del día.',
        { quote: true },
      );
      return;
    }
    const live = new Map(routineRunner.status().map((s) => [`${s.scope}\u0000${s.name}`, s]));
    const lines = scheduled.map((r) => {
      const held = live.get(`${r.scope}\u0000${r.name}`);
      const state = r.enabled ? '' : ' (desactivada)';
      const running = held?.running ? ' [en curso]' : '';
      return `- ${r.name}${state} [${r.schedule ?? 'sin horario'}] — próxima: ${nextRunLabel(
        r.schedule,
        held?.next ?? null,
      )}${running}`;
    });
    await say(inbound, [`Rutinas programadas: ${scheduled.length}`, ...lines].join('\n'), {
      quote: true,
    });
  };

  const cmdMemory = async (inbound: Inbound): Promise<void> => {
    const entries = memory.all(chatKey(inbound));
    const scopes = memory.scopes();
    await say(
      inbound,
      entries.length
        ? [
            `Recuerdo ${entries.length} cosas:`,
            ...entries.map((e) => `- [${e.id}] ${e.text}`),
          ].join('\n')
        : `No recuerdo nada todavía. Lo aprenderé sobre la marcha. (${scopes.length} conversaciones con memoria)`,
      { quote: true },
    );
  };

  /**
   * Texto de una página pública, por el mismo camino (y el mismo control SSRF) que la tool
   * fetch. La tool devuelve el texto dentro de una valla `<fetched_content>`; aquí se quita.
   */
  const fetchPageText = async (url: string): Promise<string> => {
    const tool = createFetchTool(50_000);
    const res = await tool.execute('pagewatch', { url, format: 'text' });
    const raw = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    const m = /<fetched_content[^>]*>\n?([\s\S]*?)\n?<\/fetched_content>/.exec(raw);
    return m?.[1] ?? raw;
  };

  /** /vigila <url> [nombre]: avisa cuando cambie el precio (o el texto) de una página. */
  const cmdVigila = async (inbound: Inbound, args: string): Promise<void> => {
    const parsed = parseVigilaArgs(args);
    const rawUrl = parsed?.url;
    if (!parsed || !rawUrl) {
      return void (await say(
        inbound,
        'Uso: /vigila <enlace> [nombre]. Te aviso si cambia el precio de la página. Con palabra=agotado (o palabra="sin stock") te aviso cuando esa palabra aparezca o desaparezca. /vigilando para ver la lista, /dejar_de_vigilar <id> para quitar una.',
        { quote: true },
      ));
    }
    if (!(await isFetchableResolved(rawUrl))) {
      return void (await say(inbound, 'Solo puedo vigilar enlaces públicos http(s).', {
        quote: true,
      }));
    }
    try {
      const w = pageWatches.add(inbound.chatId, rawUrl, parsed.label, parsed.keyword);
      await say(
        inbound,
        `Vale, vigilo ${w.label || w.url} (id ${w.id})${w.keyword ? ` buscando "${w.keyword}"` : ''}. Miro cada 2 horas y te aviso si cambia.`,
        {
          quote: true,
        },
      );
      void checkPageWatch(w.id);
    } catch (err) {
      await say(inbound, err instanceof Error ? err.message : String(err), { quote: true });
    }
  };

  const cmdVigilando = async (inbound: Inbound): Promise<void> => {
    const list = pageWatches.list(inbound.chatId);
    const text = list.length
      ? list
          .map((w) => `${w.id} - ${w.label || w.url} - último valor: ${w.lastValue || 'pendiente'}`)
          .join('\n')
      : 'No vigilo ninguna página. Prueba /vigila <enlace>.';
    await say(inbound, text, { quote: true });
  };

  const cmdDejarDeVigilar = async (inbound: Inbound, args: string): Promise<void> => {
    const id = args.trim();
    const ok = id ? pageWatches.remove(inbound.chatId, id) : false;
    await say(inbound, ok ? 'Hecho, ya no la vigilo.' : 'No encuentro ese id. Mira /vigilando.', {
      quote: true,
    });
  };

  const checkPageWatch = async (id: string): Promise<void> => {
    const w = pageWatches.get(id);
    if (!w?.active) return;
    const outcome = await pageWatches.check(w, fetchPageText);
    const msg = describeChange(w, outcome);
    if (outcome.kind === 'changed') {
      actions.record({
        actor: 'asistenta',
        action: 'vigila_cambio',
        target: w.label || w.url,
        result: 'ok',
      });
    }
    if (msg) {
      await telegram
        .send({ channel: 'telegram', account: telegram.account, chatId: w.scope, text: msg })
        .catch((err: unknown) => log.warn('page watch notice failed', { err }));
    }
  };

  const weeklyText = async (chatId: string): Promise<string> => {
    // El bloque de gimnasio solo aparece si openGym está emparejado; si falla, lo dice.
    const configured = await makeOpenGymClient().catch(() => null);
    const extra = configured ? await gymAnswer(gymDeps, 'semana') : '';
    return buildWeeklySummary({
      extra,
      entries: actions.recent(5000),
      now: Date.now(),
      pending: followups.safe(() => followups.summarize(), ''),
      watching: pageWatches.list(chatId).length,
    });
  };

  /** Domingo por la tarde, una vez por semana y chat. Solo datos propios de Asistenta. */
  const sendWeeklyIfDue = async (chatId: string): Promise<void> => {
    if (!isWeeklyDue(new Date(), weeklyState.lastSent(chatId))) return;
    weeklyState.markSent(chatId, Date.now());
    await telegram
      .send({
        channel: 'telegram',
        account: telegram.account,
        chatId,
        text: await weeklyText(chatId),
      })
      .catch((err: unknown) => log.warn('weekly summary failed', { err }));
  };

  const cmdGym = async (inbound: Inbound, what: GymKind): Promise<void> => {
    await say(inbound, await gymAnswer(gymDeps, what), { quote: true });
  };

  const cmdResumen = async (inbound: Inbound): Promise<void> => {
    await say(inbound, await weeklyText(inbound.chatId), { quote: true });
  };

  const PAGE_WATCH_EVERY_MS = 2 * 60 * 60 * 1000;
  const pageWatchTimer = setInterval(
    () => {
      for (const w of pageWatches.due(PAGE_WATCH_EVERY_MS)) void checkPageWatch(w.id);
      for (const userId of allowed) void sendWeeklyIfDue(String(userId));
    },
    10 * 60 * 1000,
  );
  pageWatchTimer.unref();

  const startedAt = Date.now();

  /** /estado: salud de Asistenta desde Telegram (herramientas, log de hoy, vigilancias). */
  const cmdEstado = async (inbound: Inbound): Promise<void> => {
    const ytdlp = process.env.ASISTENTA_YTDLP || 'yt-dlp';
    const ytdlpOk = await new Promise<boolean>((resolve) => {
      execFile(ytdlp, ['--version'], { timeout: 5000, windowsHide: true }, (err) => resolve(!err));
    });
    const curl = await findCurlImpersonate(config.curlImpersonatePath).catch(() => null);
    let logSummary: ReturnType<typeof summarizeLog> | null = null;
    try {
      const day = new Date().toISOString().slice(0, 10);
      logSummary = summarizeLog(readFileSync(join(paths.log, `${day}.jsonl`), 'utf8'));
    } catch {
      logSummary = null;
    }
    const text = formatStatus({
      version: process.env.npm_package_version ?? 'dev',
      node: process.version,
      uptimeMs: Date.now() - startedAt,
      tools: [
        {
          name: 'yt-dlp (vídeos)',
          ok: ytdlpOk,
          note: ytdlpOk ? undefined : 'no puedo descargar vídeos',
        },
        {
          name: 'curl-impersonate (PDF protegidos)',
          ok: curl !== null,
          note: curl ? undefined : 'opcional; sin él algunos PDF con antibot fallan',
        },
        { name: 'ffmpeg (/watch)', ok: ffmpegAvailable() },
      ],
      log: logSummary,
      pageWatches: pageWatches.list(inbound.chatId).length,
    });
    await say(inbound, text, { quote: true });
  };

  /** What the user said they would do, in the tracker's own Spanish summary. */
  const cmdFollowups = async (inbound: Inbound): Promise<void> => {
    const text = followups.safe(() => followups.summarize(), 'No he podido leer los pendientes.');
    await say(inbound, text, { quote: true });
  };

  /**
   * Retire a follow-up: the user saying "eso ya está" must actually stop the nudges.
   *
   * `resolve(id)` wants the tracker's opaque id (`date:<asunto>`), which nobody
   * remembers, so the subject is accepted too when it matches exactly one pending
   * note. A command you cannot type is not a command.
   */
  const cmdResolve = async (inbound: Inbound, args: string): Promise<void> => {
    const want = args.trim();
    if (!want) {
      await say(
        inbound,
        'Uso: /resolver <id del pendiente>. Mira los pendientes con /pendientes.',
        { quote: true },
      );
      return;
    }
    const needle = want.toLowerCase();
    const matches = followups.safe(() => {
      const pending = followups.list(undefined, 200).filter((f) => f.status === 'pending');
      const byId = pending.filter((f) => f.id === want);
      const found = byId.length
        ? byId
        : pending.filter((f) => f.subject.toLowerCase().includes(needle));
      if (found.length === 1) {
        const only = found[0];
        if (only) followups.resolve(only.id);
      }
      return found;
    }, []);
    const only = matches[0];
    if (matches.length === 1 && only) {
      await say(inbound, `Resuelto: ${only.subject}`, { quote: true });
      return;
    }
    await say(
      inbound,
      matches.length === 0
        ? `No encuentro ningún pendiente que coincida con "${want}".`
        : `Varios pendientes coinciden, dime cuál por su id:\n${matches
            .map((f) => `- ${f.id}`)
            .join('\n')}`,
      { quote: true },
    );
  };

  /** Search this conversation's past sessions, the way the model finds them. */
  const cmdSearch = async (thread: Thread, inbound: Inbound, args: string): Promise<void> => {
    const query = args.trim();
    if (!query) {
      await say(inbound, 'Uso: /buscar <texto> para buscar en conversaciones pasadas.', {
        quote: true,
      });
      return;
    }
    const hits = followups.safe(() => sessions.search(query, thread.key), []);
    await say(inbound, formatSessionHits(hits, query), { quote: true });
  };

  const cmdVoice = async (inbound: Inbound, args: string): Promise<void> => {
    const want = args.trim().toLowerCase();
    const current = voiceOn.get(inbound.chatId) ?? voiceDefault;
    const next = want === 'on' ? true : want === 'off' ? false : !current;
    voiceOn.set(inbound.chatId, next);
    await say(
      inbound,
      next ? 'Te contesto con voz cuando me hables por voz.' : 'Te contesto solo con texto.',
      { quote: true },
    );
  };

  const cmdStop = async (inbound: Inbound): Promise<void> => {
    const chatKey_ = chatKey(inbound);
    const mine = [...threads.values()].filter((t) => t.chatKey === chatKey_);
    let wasActive = 0;
    for (const thread of mine) {
      if (thread.active) wasActive++;
      thread.generation++;
      thread.agent.abort('external');
      thread.tail = Promise.resolve();
    }
    telegram.cancelForChat(inbound.chatId);
    // A live view keeps sending frames after the user asked to stop, and its photo
    // would arrive after "Detenido." - exactly the class of ghost output /stop exists
    // to prevent. The same goes for an in-flight recording.
    stopLiveView(inbound.chatId);
    for (const thread of mine) thread.gate.clearSession(thread.key);
    log.info('stop requested', { chatId: inbound.chatId, wasActive, threads: mine.length });
    await say(
      inbound,
      wasActive
        ? `Detenido. ${wasActive} conversación(es) abortadas y la cola limpia.`
        : 'No había nada en curso.',
      { quote: true },
    );
  };

  /**
   * A live view: one photo in the chat, refreshed in place every few seconds.
   *
   * Deliberately one editable message rather than a stream of photos. A stream hits
   * Telegram's documented one-message-per-second ceiling at the first frame and then
   * leaves every frame in the chat forever; editing a single message feels more like
   * watching, leaves the conversation readable afterwards, and is well inside the
   * documented limits. This is the closest thing to a live feed the Bot API allows -
   * there is no streaming primitive a bot can use.
   */
  const startLiveView = async (
    inbound: Inbound,
    source: 'screen' | 'camera',
    intervalMs: number,
    maxMs: number,
    opts: { announce?: boolean } = {},
  ): Promise<string> => {
    const chatId = inbound.chatId;
    const announce = opts.announce !== false;
    const caption =
      source === 'camera'
        ? 'Camara en directo, se actualiza sola. /camera off para parar.'
        : 'Pantalla en directo, se actualiza sola. /screen off para parar.';

    if (liveViews.has(chatId)) {
      // A second request must not silently replace the first view: two loops writing
      // to two different messages both look like a broken feed.
      const note = 'Ya hay una vista en directo. Para pararla, /screen off o /camera off.';
      if (announce) await say(inbound, note, { quote: true });
      return note;
    }
    const capture = async (): Promise<Buffer> =>
      source === 'camera'
        ? (await captureCameraFrame({ maxEdge: config.screenshotMaxEdge })).image
        : (await screen.screenshot()).image;

    let first: Buffer;
    try {
      first = await capture();
    } catch (err) {
      const note = `No he podido abrir la vista en directo: ${err instanceof Error ? err.message : String(err)}`;
      if (announce) await say(inbound, note, { quote: true });
      return note;
    }
    const id = await telegram.sendPhotoBytes(Number(chatId), first, inbound.threadId);
    if (!id) {
      const note = 'No he podido abrir la vista en directo.';
      if (announce) await say(inbound, note, { quote: true });
      return note;
    }
    if (announce) await say(inbound, caption, { quote: true });

    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > maxMs) {
        stopLiveView(chatId);
        void say(inbound, 'La vista en directo ha terminado.', { quote: true });
        return;
      }
      void capture()
        .then((bytes) => telegram.editPhoto(chatId, id, bytes))
        .catch((err: unknown) => {
          // One missed frame is not worth stopping for: the next tick retries, and only
          // a sustained failure is worth telling the user about.
          log.debug('live view frame failed', { err });
        });
    }, intervalMs);
    timer.unref();
    liveViews.set(chatId, { timer, messageId: id });
    return caption;
  };

  const stopLiveView = (chatId: string): void => {
    const job = liveViews.get(chatId);
    if (!job) return;
    clearInterval(job.timer);
    liveViews.delete(chatId);
    log.info('live view stopped', { chatId });
  };

  /**
   * Live views started from a tool call.
   *
   * `announce: false` because the model is about to tell the user in its own reply;
   * a second Telegram message saying the same thing arrives before the answer and
   * reads as the agent talking over itself.
   */
  const startLiveViewFromThread = async (
    thread: Thread,
    source: 'screen' | 'camera',
    intervalMs: number,
  ): Promise<string> =>
    startLiveView(inboundFor(thread), source, intervalMs, 15 * 60 * 1000, { announce: false });

  const stopLiveViewFromThread = async (thread: Thread): Promise<string> => {
    const chatId = inboundFor(thread).chatId;
    if (!liveViews.has(chatId)) return 'No hay ninguna vista en directo activa.';
    stopLiveView(chatId);
    return 'Vista en directo detenida.';
  };

  const cmdCamera = async (inbound: Inbound, args: string): Promise<void> => {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const sub = parts[0] ?? '';
    if (sub === 'off' || sub === 'stop') {
      stopLiveView(inbound.chatId);
      await say(inbound, 'Camara apagada.', { quote: true });
      return;
    }
    if (sub === 'on' || sub === 'live') {
      const interval = Math.max(2, Math.min(30, Number(parts[1]) || 5));
      await startLiveView(inbound, 'camera', interval * 1000, 15 * 60 * 1000);
      return;
    }
    if (sub === 'clip' || sub === 'video') {
      const seconds = Math.max(1, Math.min(60, Number(parts[1]) || 10));
      await say(inbound, `Grabando ${seconds}s de camara...`, { quote: true });
      const rec = await recordCamera({ seconds, fps: 10, maxEdge: config.screenshotMaxEdge });
      const bytes = consumeRecording(rec.file);
      await telegram.sendVideo(Number(inbound.chatId), bytes, seconds, 'Camara');
      return;
    }
    // Camera with the microphone attached. One ffmpeg with two inputs, because two
    // recordings stitched afterwards put the audio behind the video by however long
    // the second spawn took, and the drift is instantly visible on anything with a
    // voice in it.
    if (sub === 'av' || sub === 'voz' || sub === 'convoz') {
      const seconds = Math.max(1, Math.min(60, Number(parts[1]) || 10));
      await say(inbound, `Grabando ${seconds}s de camara con tu voz...`, { quote: true });
      try {
        const rec = await recordCameraWithMic({
          seconds,
          fps: 10,
          maxEdge: config.screenshotMaxEdge,
        });
        const bytes = consumeRecording(rec.file);
        await telegram.sendVideo(Number(inbound.chatId), bytes, seconds, 'Camara y voz');
      } catch (err) {
        await say(
          inbound,
          `No he podido grabar camara y microfono: ${err instanceof Error ? err.message : String(err)}`,
          { quote: true },
        );
      }
      return;
    }
    await telegram.action(inbound.chatId, 'upload_photo');
    try {
      const shot = await captureCameraFrame({ maxEdge: config.screenshotMaxEdge });
      const ok = await telegram
        .sendPhotoBytes(Number(inbound.chatId), shot.image, inbound.threadId, {
          width: shot.width,
          height: shot.height,
        })
        .then(() => true)
        .catch((err: unknown) => {
          log.warn('camera frame send failed', { err });
          return false;
        });
      await say(
        inbound,
        ok ? 'Esto veo por la camara ahora mismo.' : 'No he podido enviar la foto.',
        {
          quote: true,
        },
      );
    } catch (err) {
      await say(
        inbound,
        `No he podido usar la camara: ${err instanceof Error ? err.message : String(err)}`,
        { quote: true },
      );
    }
  };

  const cmdMic = async (inbound: Inbound, args: string): Promise<void> => {
    const seconds = Math.max(1, Math.min(60, Number(args.trim().split(/\s+/)[0]) || 10));
    await say(inbound, `Escuchando ${seconds}s por el microfono...`, { quote: true });
    try {
      // Through withMicrophone: the wake listener holds the capture device open, and
      // two recorders fighting over one microphone is a failure that looks like
      // "your microphone is broken".
      await withMicrophone(async () => {
        const rec = await recordMicrophone({ seconds });
        const bytes = consumeRecording(rec.file);
        await telegram.action(inbound.chatId, 'upload_voice');
        await telegram.sendVoiceBytes(Number(inbound.chatId), bytes, inbound.threadId, rec.seconds);
      });
    } catch (err) {
      await say(
        inbound,
        `No he podido grabar el microfono: ${err instanceof Error ? err.message : String(err)}`,
        { quote: true },
      );
    }
  };

  /**
   * Play an audio the user sent us, out of the PC speakers.
   *
   * The volume is a parameter because "let me hear it" and "let me hear it at full
   * blast" are different requests and the difference is one number. The default is
   * full volume: when someone sends an audio to their own PC from their phone, the
   * reason is usually that they are not at the keyboard and want it loud enough to
   * hear from wherever they are.
   */
  const cmdPlay = async (inbound: Inbound, args: string): Promise<void> => {
    const first = args.trim().split(/\s+/)[0] ?? '';
    const volume = first ? Math.max(0, Math.min(100, Number(first) || 100)) : 100;
    const key = chatKey(inbound);

    // The audio on this message if there is one, then the audio on the message the
    // user replied to, then the last audio they sent in this chat. That order is the
    // whole fix for "I send an audio, then type /play": the handle has to survive the
    // turn, and Telegram's file_id does, as long as something remembers it.
    const target = recall.resolve(key, {
      own: inbound.audioFileId ? inbound.messageId : undefined,
      replyTo: inbound.replyToMessageId,
    });

    if (!target) {
      await say(
        inbound,
        'No tengo ningún audio tuyo guardado. Mandame uno y te lo suelto; también puedo ' +
          'usar el último que me mandaste en cuanto llegue.',
        { quote: true },
      );
      return;
    }

    await say(inbound, `Descargando y preparando el audio (volumen ${volume})...`, { quote: true });
    let playable: string | null = null;
    try {
      const bytes = await telegram.downloadFile(target.fileId, 25_000_000);
      if (!bytes) throw new Error('no he podido descargar el audio de Telegram');
      playable = await toPlayableAudio(bytes, target.mimeType);
      // The speakers are the wake microphone's other half.
      currentWake()?.suppress(PLAYBACK_SUPPRESS_MS);
      const res = await playAudioFile(playable, { volume });
      currentWake()?.suppress(WAKE_TAIL_MS);
      await say(
        inbound,
        res.ok
          ? `Sonado ${res.seconds}s al volumen ${res.volumeSet}%. ` +
              (res.volumeRestoredTo === null
                ? 'El volumen se queda ahí.'
                : `He vuelto a dejar el volumen como estaba (${res.volumeRestoredTo}%).`)
          : `No he podido reproducirlo: ${res.detail}`,
        { quote: true },
      );
    } catch (err) {
      await say(
        inbound,
        `No he podido reproducir el audio: ${err instanceof Error ? err.message : String(err)}`,
        { quote: true },
      );
    } finally {
      if (playable) rmSync(playable, { force: true });
      currentWake()?.suppress(WAKE_TAIL_MS);
    }
  };

  const cmdStatus = async (inbound: Inbound, args: string): Promise<void> => {
    const want = args.trim().toLowerCase();
    const current = statusOn.get(inbound.chatId) !== false;
    const next = want === 'on' ? true : want === 'off' ? false : !current;
    statusOn.set(inbound.chatId, next);
    await say(
      inbound,
      next
        ? 'Te voy contando como voy mientras trabajo.'
        : 'Te aviso solo al final, sin avisos por el camino.',
      { quote: true },
    );
  };

  const cmdHelp = async (inbound: Inbound): Promise<void> => {
    await say(
      inbound,
      [
        'Habla conmigo normal y te contesto a cada mensaje por separado.',
        '',
        '/screen - captura ahora',
        '/watch [segundos [fps]] - graba la pantalla y te manda el vídeo',
        '/topic <nombre> - abre una conversación; /topics para verlas',
        '/learn <nombre> ⬦ /learn end - guarda una rutina de lo que hagamos',
        '/routine <nombre> - repite una rutina; con horario en palabras crea una programada',
        '/routines - lista de rutinas',
        '/agenda - rutinas programadas y su proxima ejecucion',
        '/memory - lo que recuerdo de ti',
        '/pendientes - lo que te tengo que recordar',
        '/resolver <id> - marca un pendiente como resuelto',
        '/entreno_hoy ⬦ /ultimo ⬦ /peso - tu gimnasio en openGym (solo lectura)',
        '/resumen - lo que he hecho esta semana (te lo mando solo los domingos por la tarde)',
        '/estado - cómo estoy: herramientas, errores de hoy',
        '/vigila <enlace> [nombre] - te aviso si cambia el precio de esa página',
        '/vigilando ⬦ /dejar_de_vigilar <id> - lista o quita lo que vigilo',
        '/buscar <texto> - busca en conversaciones pasadas',
        '/voice on|off - contestar con voz',
        '/wake on|off - escuchar mi nombre en el micrófono',
        '/camera [on|off|clip|av [seg]] - foto, directo, vídeo o vídeo con tu voz',
        '/play [volumen] - suena en el PC el último audio que me mandaste',
        '/mic [segundos] - escuchar lo que oye el microfono',
        '/watch live [segundos] - pantalla en directo (se actualiza sola)',
        '/status on|off - avisarte de como voy mientras trabajo',
        '/stop - para todo lo que esté corriendo',
      ].join('\n'),
      { quote: true },
    );
  };

  /**
   * One turn: prepare inputs (photo, voice), run, answer.
   *
   * Voice is transcribed here rather than in the adapter because the first
   * transcription has to load the model from disk, which takes seconds. Doing it in
   * the message handler would block every other conversation behind that load.
   */
  const runTurn = async (
    thread: Thread,
    inbound: Inbound,
    text: string,
    opts: { images?: Inbound['images'] },
  ): Promise<void> => {
    const generation = thread.generation;
    thread.active = true;
    // Which message this turn is answering, so a tool that sends something back can
    // quote it. Replaced per turn, because one thread serves many messages.
    threadInbound.set(thread.key, inbound);
    let lastSummary = 'recibido';
    // One episodic session per turn, closed in the finally below even when the
    // turn was cancelled or failed: a turn that produced no answer still
    // happened, and /buscar must be able to find it.
    let sessionId = '';
    safeRemember(() => {
      sessionId = sessions.begin(thread.key, inbound.text.slice(0, 80));
    });
    /** Kept for the session summary the finally writes. */
    let result: AgentRunResult | null = null;
    /** Tool names in call order; two or more in a row is an observed sequence. */
    const toolNames: string[] = [];
    const startedAt = Date.now();
    let lastStatusAt = 0;
    let finished = false;
    /** The progress notes this turn sent, so they can be taken out of the chat at the end. */
    const progressIds: string[] = [];

    // Telegram expires the typing indicator after ~5s, so it is refreshed while a run
    // is alive. It says "working" without inventing a progress report.
    const typing = setInterval(() => {
      if (finished) return;
      void telegram.action(inbound.chatId, 'typing');
    }, 4000);
    typing.unref();

    const status = setInterval(() => {
      if (finished) return;
      // The progress note is opt-out per chat: some people want to be told how it is
      // going while it works, others want one message at the end and nothing between.
      if (statusOn.get(inbound.chatId) === false) return;
      const now = Date.now();
      if (now - startedAt > 25_000 && now - lastStatusAt > 45_000) {
        lastStatusAt = now;
        void telegram
          .send({
            channel: 'telegram',
            account: telegram.account,
            chatId: inbound.chatId,
            // Varied and short. A progress note that says the same three words every
            // time reads as an automated nag; this is the same information in the
            // voice of someone checking in.
            text: `${progressMessage()} — ${lastSummary}.`,
          })
          .then((id) => {
            if (id) progressIds.push(id);
          })
          .catch(() => {});
      }
    }, 5000);
    status.unref();

    try {
      let images = opts.images;
      if (!images?.length && inbound.photoFileId) {
        try {
          const data = await telegram.downloadPhoto(inbound.photoFileId);
          if (data)
            images = [{ type: 'image', mimeType: 'image/jpeg', data: data.toString('base64') }];
        } catch (err) {
          log.warn('photo download failed', { err });
        }
      }

      let prompt = text;
      if (inbound.audioFileId) {
        const bytes = await telegram.downloadFile(inbound.audioFileId);
        if (!bytes) {
          await say(inbound, 'No he podido descargar el audio.', { quote: true });
          return;
        }
        await telegram.action(inbound.chatId, 'typing');
        try {
          const heard = await transcribeVoiceNote(bytes, { mimeType: inbound.audioMimeType });
          // Marked as a transcription so the model does not treat a misheard word as
          // something the user typed, and so the reply can be spoken back.
          prompt = `[Nota de voz transcrita] ${heard.text}`;
          log.info('voice transcribed', {
            seconds: heard.durationSeconds,
            chars: heard.text.length,
          });
          // Remembered with the handle, so "suéltame ese audio" two messages later
          // has something to act on.
          recall.setTranscript(chatKey(inbound), inbound.messageId, heard.text);
        } catch (err) {
          await say(
            inbound,
            `No he entendido la nota de voz: ${err instanceof Error ? err.message : String(err)}`,
            { quote: true },
          );
          return;
        }
      }

      if (!prompt.trim() && !images?.length) {
        await say(inbound, 'No he visto texto ni imagen en ese mensaje.', { quote: true });
        return;
      }

      // Memory and routines are injected as a system message, so they read as
      // standing context rather than as something the user just said.
      thread.agent.attachContext(
        buildContextNote(thread, store, memory, snapshot, workstreams, skills),
      );

      result = await thread.agent.run(prompt, images, {
        onToolCall: (info) => {
          lastSummary = info.summary;
          toolNames.push(info.tool);
          // Mid-turn trail: a session that only holds the final answer cannot
          // answer "what did you do first?" two days later.
          safeRemember(() => sessions.addTurn(sessionId, 'assistant', info.summary));
        },
      });

      if (thread.generation !== generation) return;

      // Learn from this run's problems: a tool failed and another way then worked.
      // Built from the structured trail only, saved straight into `lecciones`.
      const learned = recordLessons(skills, result.steps, new Date().toISOString().slice(0, 10));
      if (learned.length) log.info('lessons saved', { thread: thread.name, ids: learned });

      log.info('task done', {
        thread: thread.name,
        toolCalls: result.toolCalls,
        blocked: result.blocked,
        toolErrors: result.toolErrors,
        stopReason: result.stopReason,
        failed: result.error !== null,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      });

      const text2 =
        result.text.trim() || (result.error ? `Fallo: ${result.error}` : 'Sin respuesta.');
      await answer(thread, inbound, text2);
      // The answer itself joins the session record: it is what /buscar reads back
      // when the user asks "what did you tell me about that?".
      const finalText = result.text;
      safeRemember(() => sessions.addTurn(sessionId, 'assistant', finalText));

      // What happened, kept where the user can ask about it later: "¿qué enviaste
      // anoche?" is a question about a past action, and without a record the honest
      // answer is "no sé".
      actions.record({
        actor: 'asistenta',
        action: result.error ? 'turn' : 'turn',
        target: thread.name,
        result: result.error ? 'error' : 'ok',
        detail: `${result.toolCalls} tools, ${Math.round((Date.now() - startedAt) / 1000)}s`,
      });

      // What this turn taught: a stated preference, and the tool sequence that
      // actually happened. Successful turns only - a failed one is not a pattern
      // worth repeating.
      if (!result.error) {
        for (const { pattern, category } of instinctsFromTurn(inbound.text, toolNames)) {
          safeRemember(() => instincts.observe(pattern, category, thread.key));
        }
      }

      // A durable fact said out loud is worth offering to keep. The user should not
      // have to remember to ask: the moment they say "prefiero X" is the moment it
      // costs least to write it down.
      const nudge = detectMemoryWorthy(inbound.text);
      if (nudge.worth) {
        await say(inbound, nudge.suggestion, { quote: true }).catch(() => {});
      }

      // A promise with a date attached is a follow-up, not just a fact: "voy a
      // pagar el seguro el viernes" is something to mention on Friday.
      const promised = followupFromMessage(inbound.text);
      if (promised) {
        safeRemember(() => followups.track(thread.key, 'date', promised.subject, promised.dueAt));
      }
    } catch (err) {
      log.error('turn threw', { thread: thread.name, err });
      await say(inbound, `Algo falló: ${err instanceof Error ? err.message : String(err)}`, {
        quote: true,
      });
    } finally {
      finished = true;
      thread.active = false;
      clearInterval(typing);
      clearInterval(status);
      // The closing summary is what later searches read, so the session is closed
      // even when the turn was cancelled or produced no answer at all.
      const summary = result?.text.slice(0, 200) ?? '';
      safeRemember(() => sessions.end(sessionId, summary));
      // The progress notes are scaffolding, not part of the conversation. Leaving
      // them turns a chat into a log of what the agent did instead of a dialogue, so
      // they go once the real answer has arrived. Best effort: a note Telegram will
      // not delete stays, and that is fine.
      for (const id of progressIds) {
        await telegram.deleteMessage(inbound.chatId, id).catch(() => {});
      }
      // Approval scope is one task: a memo or grant must never leak into the next
      // turn, where the user has new context that the approval did not cover.
      thread.gate.clearSession(thread.key);
    }
  };

  // ---- wake word -----------------------------------------------------------

  /** Monotonic id so every wake turn is traceable in the log and in /topics. */
  let wakeCount = 0;

  /**
   * Answer a wake word.
   *
   * It runs through `runTurn` like any other message, with three deliberate
   * differences: it goes to the main conversation of whoever talked last, it is
   * marked as spoken rather than typed, and it forces a spoken answer. Everything
   * else - the gate, the mutex, the threading, the machine lock - is the same code
   * path, because a second way into the agent is a second thing that can skip the
   * safety checks.
   */
  const handleWake = async (heard: string): Promise<void> => {
    const chat = lastChat;
    if (!chat) {
      log.warn('wake word heard but nobody has talked yet', { heard });
      return;
    }
    const request = stripWakeWord(heard, wakeWord);
    if (!request) {
      // "Asistenta" on its own is a check that it is listening, not a task. Saying so
      // would answer every cough that sounded like the word.
      log.info('wake word heard with no request', { heard });
      return;
    }
    const inbound: Inbound = {
      channel: 'telegram',
      account: telegram.account,
      chatId: chat.chatId,
      threadId: chat.threadId,
      userId: String(chat.chatId),
      displayName: 'palabra de activacion',
      text: `[dicho en voz alta ante el microfono] ${request}`,
      authorised: true,
      messageId: `wake-${++wakeCount}`,
      receivedAt: new Date().toISOString(),
    };
    log.info('wake word fired', { request, chatId: chat.chatId });
    const thread = await getOrCreateThread(chat.key, 'main', 'principal');
    messageThread.set(`${chat.key}:${inbound.messageId}`, thread.key);
    // Spoken in, spoken out: nobody is looking at the chat to read a reply to a
    // word they said to an empty room.
    const wasVoice = voiceOn.get(chat.chatId);
    voiceOn.set(chat.chatId, true);
    try {
      await runTurn(thread, inbound, inbound.text, {});
    } finally {
      if (wasVoice === undefined) voiceOn.delete(chat.chatId);
      else voiceOn.set(chat.chatId, wasVoice);
    }
  };

  /**
   * Tell the last chat something about the wake word, with no message to quote.
   *
   * Separate from `say` because the wake word arrives with no inbound message: there is
   * nothing to attach this to, and a fabricated id would make it look like a reply to
   * something the user never wrote.
   */
  const notifyLastChat = async (text: string): Promise<void> => {
    const chat = lastChat;
    if (!chat) return;
    await say(
      {
        channel: 'telegram',
        account: telegram.account,
        chatId: chat.chatId,
        threadId: chat.threadId,
        userId: String(chat.chatId),
        text: '',
        authorised: true,
        messageId: 'wake-notice',
        receivedAt: new Date().toISOString(),
      },
      text,
      { quote: false },
    );
  };

  const startWake = async (): Promise<void> => {
    if (!desktop) throw new Error('sin micrófono en modo servidor');
    let told = false;
    const listener = new WakeWordListener({
      word: wakeWord,
      onWake: (heard) => {
        // Deliberately not awaited: a wake starts a whole turn, and the listener's
        // job is done the moment it has handed the text over.
        void handleWake(heard).catch((err: unknown) => log.error('wake turn failed', { err }));
      },
      onError: (err) => {
        log.warn('wake listener error', { err });
        // The listener stops itself when capture or transcription fails, and from the
        // user's side a listener that stopped listening is indistinguishable from one
        // that never started. Said once: the failure repeats until it is fixed.
        if (told) return;
        told = true;
        void notifyLastChat(
          `He dejado de escuchar "${wakeWord}": ${err.message}. Vuelve a activarlo con /wake on.`,
        ).catch(() => {});
      },
    });
    await listener.start();
    wake = listener;
    log.info('wake word listening', { word: wakeWord, ...listener.stats() });
  };

  const stopWake = async (): Promise<void> => {
    const listener = wake;
    if (!listener) return;
    wake = null;
    await listener.stop();
    log.info('wake word stopped', listener.stats());
  };

  const cmdWake = async (inbound: Inbound, args: string): Promise<void> => {
    const want = args.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    const listening = currentWake()?.isRunning() ?? false;
    const next = want === 'on' ? true : want === 'off' ? false : !listening;
    try {
      if (next) await startWake();
      else await stopWake();
    } catch (err) {
      await say(
        inbound,
        `No he podido ${next ? 'activar' : 'desactivar'} la palabra: ${err instanceof Error ? err.message : String(err)}`,
        { quote: true },
      );
      return;
    }
    wakeWanted = next;
    // Persisted, so "stop listening" survives a restart. Without this the daemon would
    // grab the microphone again on the next boot and the user would have to remember
    // to switch it off a second time.
    await vaultSet('agent:wake', next ? 'on' : 'off').catch((err: unknown) => {
      log.warn('wake preference not saved', { err });
    });
    const stats = currentWake()?.stats();
    await say(
      inbound,
      next
        ? `Escuchando "${wakeWord}" en el microfono. Dime "${wakeWord}, ..." y te hago caso.` +
            (stats ? ` (ventanas oidas: ${stats.checks}, avisos: ${stats.wakeCount})` : '')
        : `Dejo de escuchar "${wakeWord}".`,
      { quote: true },
    );
  };

  await registry.startAll({
    onMessage: async (inbound) => {
      if (!inbound.authorised) return;
      const chatKey_ = chatKey(inbound);
      log.info('message', {
        chatId: inbound.chatId,
        user: inbound.displayName,
        chars: inbound.text.length,
        hasPhoto: Boolean(inbound.photoFileId),
        hasVoice: Boolean(inbound.audioFileId),
      });

      // Telegram delivers at-least-once; a redelivered update must not run the task
      // twice. Bounded by a one hour TTL, which comfortably outlives a redelivery.
      const dedupKey = `${chatKey_}:${inbound.messageId}`;
      const seenAt = seenMessages.get(dedupKey);
      if (seenAt !== undefined && Date.now() - seenAt < 3_600_000) {
        log.info('duplicate update ignored', { messageId: inbound.messageId });
        return;
      }
      seenMessages.set(dedupKey, Date.now());
      if (seenMessages.size > 2000) {
        const oldest = seenMessages.keys().next().value;
        if (oldest !== undefined) seenMessages.delete(oldest);
      }

      // Where a wake word gets answered, and what "the last audio" means from now on.
      lastChat = { key: chatKey_, chatId: inbound.chatId, threadId: inbound.threadId };

      // Recorded before the command dispatch, because "/play" typed as the caption of
      // an audio has to be able to find that audio by its own message id.
      if (inbound.audioFileId) {
        recall.record(chatKey_, {
          fileId: inbound.audioFileId,
          mimeType: inbound.audioMimeType ?? 'audio/ogg',
          messageId: inbound.messageId,
          durationSeconds: inbound.audioDurationSeconds,
          caption: inbound.text.trim() || undefined,
        });
      }

      const command = parseCommand(inbound.text);
      if (command) {
        // Commands bypass the agent entirely: they are the user's hands on the
        // machine, not a task to delegate, and they must work even when every thread
        // is busy or the provider is down.
        switch (command.name) {
          case 'stop':
            return cmdStop(inbound);
          case 'screen':
            return cmdScreen(inbound, command.args);
          case 'camera':
          case 'play':
          case 'suena':
          case 'toca':
          case 'escucha':
          case 'mic':
          case 'micro':
          case 'watch':
            if (!desktop) return say(inbound, DESKTOP_OFF_MESSAGE, { quote: true }).then(() => {});
            if (command.name === 'camera') return cmdCamera(inbound, command.args);
            if (command.name === 'mic' || command.name === 'micro')
              return cmdMic(inbound, command.args);
            if (command.name === 'watch') return cmdWatch(inbound, command.args);
            return cmdPlay(inbound, command.args);
          case 'topic':
            return cmdTopic(inbound, command.args);
          case 'topics':
            return cmdTopics(inbound);
          case 'routines':
            return cmdRoutines(inbound);
          case 'routine': {
            const thread = await resolveThread(inbound);
            return cmdRoutine(thread, inbound, command.args);
          }
          case 'learn': {
            const thread = await resolveThread(inbound);
            return cmdLearn(thread, inbound, command.args);
          }
          case 'memory':
            return cmdMemory(inbound);
          case 'pendientes':
          case 'followups':
            return cmdFollowups(inbound);
          case 'entreno_hoy':
            return cmdGym(inbound, 'hoy');
          case 'ultimo':
            return cmdGym(inbound, 'ultimo');
          case 'peso':
            return cmdGym(inbound, 'peso');
          case 'resumen':
            return cmdResumen(inbound);
          case 'estado':
            return cmdEstado(inbound);
          case 'vigila':
            return cmdVigila(inbound, command.args);
          case 'vigilando':
            return cmdVigilando(inbound);
          case 'dejar_de_vigilar':
            return cmdDejarDeVigilar(inbound, command.args);
          case 'resolver':
          case 'resolve':
            return cmdResolve(inbound, command.args);
          case 'buscar':
          case 'search': {
            const thread = await resolveThread(inbound);
            return cmdSearch(thread, inbound, command.args);
          }
          case 'agenda':
            return cmdAgenda(inbound);
          case 'voice':
            return cmdVoice(inbound, command.args);
          case 'wake':
          case 'asistenta':
            return cmdWake(inbound, command.args);
          case 'status':
            return cmdStatus(inbound, command.args);
          case 'start':
          case 'help':
            return cmdHelp(inbound);
          default:
            // Unknown slash command: say so instead of silently running it as a task.
            await say(inbound, `No conozco el comando /${command.name}. /help para ver la lista.`, {
              quote: true,
            });
            return;
        }
      }

      const thread = await resolveThread(inbound);
      messageThread.set(dedupKey, thread.key);

      // Serialise inside the thread only. Different threads run concurrently; the
      // machine mutex inside the tools is what keeps them from colliding.
      const gen = thread.generation;
      const next = thread.tail.then(async () => {
        if (thread.generation !== gen) return;
        await runTurn(thread, inbound, inbound.text, {});
      });
      thread.tail = next.catch(() => {});
    },
    log: (level, msg, fields) => log[level](msg, fields ?? {}),
  });

  log.info('daemon ready', { allowed, threads: threads.size });

  // Started last, and off the critical path: a machine with no microphone, or one
  // where the device is already held by Teams, must still end up with a working
  // Telegram daemon. A failure here is logged and reported in /wake, never thrown.
  if (wakeWanted) {
    await startWake().catch(async (err: unknown) => {
      wakeWanted = false;
      log.error('wake word could not start', { err });
      if (lastChat) {
        await say(
          {
            channel: 'telegram',
            account: telegram.account,
            chatId: lastChat.chatId,
            threadId: lastChat.threadId,
            userId: String(lastChat.chatId),
            text: '',
            authorised: true,
            messageId: 'wake-start-failed',
            receivedAt: new Date().toISOString(),
          },
          `No he podido escuchar la palabra "${wakeWord}": ${err instanceof Error ? err.message : String(err)}`,
          { quote: true },
        );
      }
    });
  }

  log.info('daemon running', {
    wake: currentWake()?.isRunning() ?? false,
    wakeWord,
    rememberedAudio: recall.size,
  });
  await lifecycle.done;
  return 0;
}

/**
 * Text destined for speech.
 *
 * Markdown is read terribly aloud, and a 900-character answer becomes a 90-second
 * voice note nobody asked for. Code blocks are dropped entirely and replaced by a
 * marker, because a model quoting a stack trace at 2am on a phone is useless.
 */
export function trimForSpeech(text: string): string {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' (bloque de codigo omitido) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_#>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 900 ? `${cleaned.slice(0, 900)}...` : cleaned;
}

/**
 * Best-effort write to the episodic memory.
 *
 * Memory bookkeeping must never be what fails a turn: a broken table is a log
 * line, not an "Algo falló" in the middle of something the user asked for.
 */
function safeRemember(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    log.warn('memory bookkeeping failed', { err });
  }
}

/**
 * Lowercase and strip accents, so "mañana" and "manana" match the same pattern.
 * Only used for matching; stored text keeps the user's own spelling.
 */
function foldAccents(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * The four preference words the instinct category was designed for. Broader
 * matching would record noise as instinct and dilute the confidence counts.
 */
const PREFERENCE_MARKERS = /\b(prefiero|me gusta\w*|siempre|nunca)\b/iu;

/**
 * Words that say "this has a date on it". Closed list on purpose: a follow-up
 * guessed from an ordinary sentence is a nudge the user never asked for.
 */
const DATE_SIGNALS =
  /\b(vence\w*|ma[nñ]ana|pasado ma[nñ]ana|antes del|antes de|proxima semana|semana que viene|en \d{1,3} dias?|(?:el |al |los |cada )?(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)(?: que viene)?)\b/;

const WEEKDAYS: Record<string, number> = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
};

const DAY_MS = 86_400_000;

/**
 * "por la mañana" says when someone likes something, never when it is due. The
 * phrase is dropped before date matching so "prefiero el café por la mañana"
 * does not become a follow-up for tomorrow.
 */
function withoutTimeOfDay(folded: string): string {
  return folded.replace(/\bpor la (?:manana|tarde|noche)\b/g, ' ');
}

/**
 * When a promised thing is due, from the words around it.
 *
 * Deliberately rough: a follow-up that fires on the wrong day is still useful,
 * and the tracker re-reports anything unresolved. Anything with a date we cannot
 * place ("antes del día 12") is a promise all the same, and one week out is the
 * honest default rather than dropping it.
 */
function estimateDueAt(text: string, now: number): number {
  const folded = withoutTimeOfDay(foldAccents(text));
  // "pasado mañana" is read first: both sentences contain the word "mañana".
  if (/\bpasado ma[nñ]ana\b/.test(folded)) return now + 2 * DAY_MS;
  if (/\bma[nñ]ana\b/.test(folded)) return now + DAY_MS;
  const inN = /\ben (\d{1,3}) (dias?|semanas?)\b/.exec(folded);
  if (inN) {
    const n = Number(inN[1]);
    return now + n * ((inN[2] ?? '').startsWith('semana') ? 7 * DAY_MS : DAY_MS);
  }
  const dayName = /\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/.exec(folded)?.[1];
  const target = dayName ? WEEKDAYS[dayName] : undefined;
  if (target !== undefined) {
    // Next occurrence, today included: "vence el viernes" said on a Friday is
    // about today, not about a week from now.
    const delta = (target - new Date(now).getDay() + 7) % 7;
    return now + delta * DAY_MS;
  }
  return now + 7 * DAY_MS;
}

/**
 * What this turn teaches the instinct store: a stated preference in the user's
 * own words, and the tool sequence that actually happened. The raw text, not a
 * paraphrase, so a repeated pattern raises its own confidence instead of forking
 * into a near-duplicate.
 */
export function instinctsFromTurn(
  userText: string,
  toolNames: readonly string[],
): Array<{ pattern: string; category: 'pref' | 'seq' }> {
  const out: Array<{ pattern: string; category: 'pref' | 'seq' }> = [];
  const said = userText.trim();
  if (said && PREFERENCE_MARKERS.test(said)) {
    out.push({ pattern: said.slice(0, 200), category: 'pref' });
  }
  // One tool call is an action; two or more in a row is a way of working.
  if (toolNames.length >= 2) {
    out.push({ pattern: toolNames.join(' -> '), category: 'seq' });
  }
  return out;
}

/**
 * A promise with a date in it, shaped for the follow-up tracker.
 *
 * Detection reuses `detectMemoryWorthy` on purpose: the sentence worth keeping
 * ("voy a pagar el seguro el viernes") is the sentence carrying the promise, and
 * one detector keeps memory and follow-ups in step. A durable statement with no
 * date at all is memory, not a follow-up, and comes back as null.
 */
export function followupFromMessage(
  text: string,
  now = Date.now(),
): { subject: string; dueAt: number } | null {
  const nudge = detectMemoryWorthy(text);
  if (!nudge.worth || !DATE_SIGNALS.test(withoutTimeOfDay(foldAccents(text)))) return null;
  // The clause the nudge already quoted is the best subject: it is what the user
  // will recognise in /pendientes.
  const first = nudge.suggestion.indexOf('"');
  const last = nudge.suggestion.lastIndexOf('"');
  const quoted = first >= 0 && last > first ? nudge.suggestion.slice(first + 1, last) : '';
  const subject = (quoted || text.trim()).replace(/\s+/g, ' ').slice(0, 160);
  return { subject, dueAt: estimateDueAt(text, now) };
}

/**
 * Search hits as a short Spanish list. The title says which conversation, the
 * snippet says why it matched; nothing else is worth the screen it takes.
 */
export function formatSessionHits(hits: readonly SessionHit[], query = ''): string {
  if (!hits.length) {
    return query
      ? `No he encontrado nada sobre "${query}" en el historial de esta conversación.`
      : 'No he encontrado nada en el historial de esta conversación.';
  }
  const lines = hits.map((h) => {
    const day = new Date(h.at).toISOString().slice(0, 10);
    const snippet = h.snippet.replace(/\s+/g, ' ').trim();
    return `- ${h.title.trim() || 'sin título'} (${day}): ${snippet}`;
  });
  return [`Esto es lo que encontré (${hits.length}):`, ...lines].join('\n');
}

/**
 * Words that carry the schedule rather than the task. Stripped before naming, so
 * "cada mañana a las 8 resumen del día" becomes the routine "resumen" - the name
 * the user then types back in /routine.
 */
const SCHEDULE_WORDS = new Set([
  'a',
  'al',
  'cada',
  'con',
  'de',
  'del',
  'dia',
  'dias',
  'domingo',
  'el',
  'en',
  'hora',
  'horas',
  'jueves',
  'la',
  'las',
  'lo',
  'los',
  'lunes',
  'manana',
  'martes',
  'mes',
  'meses',
  'miercoles',
  'minuto',
  'minutos',
  'noche',
  'para',
  'por',
  'proxima',
  'que',
  'sabado',
  'semana',
  'semanas',
  'tarde',
  'todos',
  'un',
  'una',
  'viernes',
  'y',
]);

export function routineNameFromPrompt(prompt: string): string {
  const words = foldAccents(prompt)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !SCHEDULE_WORDS.has(w) && !/^\d+$/.test(w));
  const slug = words
    .slice(0, 6)
    .join('-')
    .replace(/[^a-z0-9-]/g, '');
  return slug || 'rutina';
}

/** A local stamp with a rough distance, for the agenda and the creation reply. */
export function formatNextRun(at: number, now = Date.now()): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const delta = at - now;
  if (delta <= 0) return `${stamp} (ya)`;
  // Whole units chosen before rounding, so half an hour never rounds up into
  // "en 1 h" and reads wrong for the next thirty minutes.
  if (delta >= 2 * DAY_MS) return `${stamp} (en ${Math.round(delta / DAY_MS)} d)`;
  if (delta >= 3_600_000) return `${stamp} (en ${Math.round(delta / 3_600_000)} h)`;
  return `${stamp} (en ${Math.max(1, Math.round(delta / 60_000))} min)`;
}

/**
 * When a scheduled routine next fires, as text for the user. The live runner
 * answers first because it knows about held first fires; a routine that never
 * registered still gets an answer from its own cron expression.
 */
export function nextRunLabel(
  schedule: string | null,
  liveNext: string | null | undefined,
  now = Date.now(),
): string {
  if (liveNext) {
    const at = Date.parse(liveNext);
    if (Number.isFinite(at)) return formatNextRun(at, now);
  }
  const check = schedule ? validateSchedule(schedule) : null;
  return check?.ok ? check.next : 'sin próxima ejecución';
}

/**
 * The memory and routines the model should have in front of it this turn, as one
 * short block.
 *
 * Bounded on purpose. A month of memories pasted into every prompt would cost
 * thousands of tokens per message and would eventually crowd out the actual task, so
 * the most recent entries are what is shown: the recent past is what a running
 * conversation needs, and `recall` covers the rest.
 */
export function buildContextNote(
  thread: { key: string; name: string },
  store: Store,
  memory: MemoryStore,
  snapshot?: MemorySnapshot,
  workstreams?: WorkstreamStore,
  skills?: SkillStore,
): string {
  const parts: string[] = [];

  // The frozen memory first: who the user is and what the agent has learned about
  // them, read from disk rather than rebuilt per turn. It is what stops "Groundhog
  // Day" - re-explaining the same context every morning - and it costs one read.
  const frozen = snapshot?.contextNote() ?? '';
  if (frozen) parts.push(frozen);

  const entries = memory.all(thread.key).slice(-20);
  if (entries.length) {
    parts.push(`<memory>\n${entries.map((e) => `- ${e.text}`).join('\n')}\n</memory>`);
  }
  const routines = store.listRoutines(thread.key).filter((r) => r.enabled);
  if (routines.length) {
    parts.push(
      `<routines>\n${routines
        .map((r) => `- ${r.name} (${r.kind})${r.schedule ? ` [${r.schedule}]` : ''}`)
        .join('\n')}\n</routines>`,
    );
  }
  // Open fronts of work, as the compact index the store writes for prompts.
  // Gated on active ones: `index()` always answers with text, and a standing
  // "nothing open" line would pay tokens on every turn to say nothing.
  const openWork = workstreams?.active(thread.key) ?? [];
  if (openWork.length) {
    const ws = workstreams?.index(thread.key) ?? '';
    if (ws) parts.push(`<workstreams>\n${ws}\n</workstreams>`);
  }
  // What the agent already knows how to do (including its own lessons), as a
  // one-line-each index; the steps load on demand with `skills read`.
  if (skills) {
    let index = '';
    try {
      index = skillsIndex(skills.list());
    } catch (err) {
      log.warn('skills index failed', { err: String(err) });
    }
    if (index) parts.push(index);
  }
  // The remote `buildNowNote()` replaces the raw `<now>` tag: it says which day
  // "mañana" actually is, so a reply asked at 00:05 does not read it as today.
  parts.push(buildNowNote());
  return parts.join('\n');
}

/**
 * Flatten a transcript into text for the /learn summariser.
 *
 * Only the turns that describe actions: tool names and the model's own words. The
 * user's messages are included because "haz la compra" is the intent the steps have
 * to serve, but the tool *arguments* are not, because a typed password would be
 * written into a routine that lives in the database forever.
 */
export function summarizeTranscript(messages: readonly unknown[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const m = message as {
      role?: string;
      content?: unknown;
      toolName?: string;
    };
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'user') {
      const text = textOf(m.content);
      if (text) lines.push(`usuario: ${text.slice(0, 300)}`);
    } else if (m.role === 'assistant') {
      const text = textOf(m.content);
      if (text) lines.push(`agente: ${text.slice(0, 300)}`);
    } else if (m.role === 'toolResult' || m.toolName) {
      const name = (m as { toolName?: string }).toolName;
      if (name) lines.push(`herramienta: ${name}`);
    }
  }
  return lines.slice(-80).join('\n') || '(no hubo actividad)';
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: string; text: string } => {
      const block = b as { type?: unknown; text?: unknown };
      return block?.type === 'text' && typeof block.text === 'string';
    })
    .map((b) => b.text)
    .join(' ');
}

/**
 * True only when node was asked to run THIS file. Tests import helpers from this
 * module (see test/newfeatures.test.ts) and must not boot anything: the old
 * unconditional call ran `main` on import, which walked into `assertNotRunning`
 * and printed "another agent is already running" into every test run.
 */
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const entryUrl = pathToFileURL(entry).href;
  // Windows paths are case-insensitive and the drive letter's case depends on how
  // the process was launched, so an exact URL match alone would miss its own entry.
  return import.meta.url === entryUrl || import.meta.url.toLowerCase() === entryUrl.toLowerCase();
}

if (isEntrypoint()) {
  // Set exitCode and let Node drain on its own. Calling process.exit() here trips a
  // libuv assertion on Windows ("!(handle->flags & UV_HANDLE_CLOSING)") because the
  // provider stream may still be tearing down its socket at that instant.
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      log.error('fatal', { err });
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
