// FIRST import, always: loads the optional .env before any module that
// captures process.env at evaluation time (paths.ts, log.ts). See envfile.ts.
import './envfile.js';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { loadCalendar } from './agenda/ics.js';
import { readAgendaOverview } from './agenda/overview.js';
import { readLocalCalendar } from './agenda/sources.js';
import { buildAgenda } from './agenda/unified.js';
import { FollowupTracker } from './alerts/followups.js';
import { formatApproval } from './approval-text.js';
import { ActionLog } from './audit/log.js';
import { isBackupDue, runBackup } from './backup.js';
import { KINDLE_VAULT_KEY } from './books/kindle.js';
import { BrowserService } from './browser/service.js';
import {
  cleanForTelegram,
  progressNote,
  shorten,
  stripVoicePrefix,
} from './channels/formatters.js';
import { QaChannel } from './channels/qa.js';
import { ChannelRegistry } from './channels/registry.js';
import { type ApprovalChoice, TelegramChannel } from './channels/telegram.js';
import type { ChannelAudio, Inbound } from './channels/types.js';
import { chatKey } from './channels/types.js';
import { loadConfig } from './config.js';
import { type ControlStartup, controlledDaemon } from './controlled-daemon.js';
import type { AgentRunResult } from './core/agent.js';
import { PersonalAgent } from './core/agent.js';
import { attentionFreeConfig, createAttentionJudge } from './core/attention-model.js';
import { dedupeNewFacts } from './core/history.js';
import { createProviderHandle } from './core/provider.js';
import { THREAD_ALLOW_TOOLS } from './core/toolset.js';
import { parseCronAdd, parseNatural } from './cron/scheduler.js';
import { applyConfiguredTimeZone, buildNowNote, localTimeZone } from './datecontext.js';
import { Store } from './db.js';
import { addHypothesis, describeLast, isEvolveDue, runEvolution } from './evolve/run.js';
import { createFactorySync } from './factory/loader.js';
import { PlaybookStore } from './gestor/playbooks.js';
import { effectOverrideReason, GestorStore } from './gestor/store.js';
import { GoalNotifier, goalNotifyTarget, NOTIFY_FLUSH_INTERVAL_MS } from './goals/notify.js';
import { GoalRunner, type GoalTickResult, isGoalRoutine } from './goals/runner.js';
import { GoalStore, splitGoalScope } from './goals/store.js';
import { IphoneClient } from './iphone/client.js';
import { LearnRecorder } from './learn.js';
import { assertNotRunning, installLifecycle } from './lifecycle.js';
import { llmHealthCommand } from './llm-health.js';
import { log, redact } from './log.js';
import { loadAccount as loadMailAccount, searchMail, sendMail } from './mail/client.js';
import { type IdleCursor, loadReadMailAccount, MailIdleTransport } from './mail/idle.js';
import { listReplyInbox, resolveReplyCard } from './mail/reader.js';
import { loadSendMailAccount, replyOnOwnerRequest } from './mail/reply.js';
import { mailStatus } from './mail/status.js';
import { findCurlImpersonate } from './media/download.js';
import { AudioRecall } from './media/recall.js';
import { isConsolidationDue, runConsolidation } from './memory/consolidate.js';
import { renderMemoryContext } from './memory/context.js';
import { DecisionLedger } from './memory/decisions.js';
import { canExtract, DocMemory } from './memory/docs.js';
import { imageExtension, imageNote, ocrImageBytes } from './memory/images.js';
import { InstinctStore } from './memory/instincts.js';
import { detectMemoryWorthy } from './memory/nudges.js';
import { semanticFromEnv } from './memory/semantic.js';
import type { SessionHit } from './memory/sessions.js';
import { SessionStore } from './memory/sessions.js';
import { MemorySnapshot } from './memory/snapshot.js';
import { NudgeTracker } from './memory/usermodel.js';
import { WorkstreamStore } from './memory/workstreams.js';
import { looksLikeCredential, MemoryStore } from './memory.js';
import { parseOcrMode, runOcrJob } from './ocrdoc/job.js';
import { OcrFolderWatcher, watchModeFromEnv } from './ocrdoc/watcher.js';
import { windowsDeps } from './ocrdoc/windows.js';
import { DEFAULT_QUIET_HOURS } from './ojo.js';
import {
  createDownloadsController,
  getDownloadsEnabled,
  setDownloadsEnabled,
} from './ojo-downloads.js';
import { AttentionQueue } from './ojo-events.js';
import { activateRule, deleteRule, dismissNotice, formatRules, listRules } from './ojo-ignore.js';
import {
  getScreenEnabled,
  type ScanOutcome,
  scanScreenOnce,
  screenStatusText,
  setScreenEnabled,
} from './ojo-screen.js';
import { OpenGymError } from './opengym/client.js';
import { makeOpenGymClient, NOT_CONFIGURED, pairOpenGym } from './opengym/setup.js';
import { ensureDirs, paths } from './paths.js';
import {
  BROWSER_FREE_ACTIONS,
  Gate,
  protectedRepoPaths,
  runPermisosCommand,
} from './permissions.js';
import { deepResearch, renderReport } from './research/deep-research.js';
import { drainThreadTails } from './shutdown-drain.js';
import { refineFromLessons } from './skills/refine.js';
import { checkTelegramToken, startupFailureMessage, withInboundFailureReply } from './startup.js';
import {
  buildTriggerPrompt,
  formatTriggerList,
  parseTriggerAdd,
  TriggerEngine,
} from './triggers.js';

/**
 * Never-writable paths, in every mode: the user's secrets, the OS, and the
 * parts of this repo that guard the agent itself (protectedRepoPaths locates
 * the repo from the module's own URL, so any cwd works). The self-improve
 * loop runs through these same gates: it can improve any code except the code
 * that keeps it honest. This guards path-carrying tools (write/edit); shell
 * commands that write files are a separate, unsolved surface - partial
 * protection, not a full cage.
 */
function protectedPaths(): string[] {
  const home = process.env.USERPROFILE;
  return [
    ...(home ? [`${home}\\.ssh`, `${home}\\.aws`] : []),
    'C:\\Windows\\System32',
    ...protectedRepoPaths(),
    // Writing a secret is as bad as reading it: a written approvals.db is a
    // self-granted standing approval, a written vault is a planted secret.
    ...secretStatePaths(),
  ];
}

/**
 * Files the agent must never read through a tool call: its own secrets. The
 * vault, the approvals database and the .env decrypt or grant everything
 * else; they are only ever opened by the code that owns them. The same files
 * are write-protected too (a written approvals.db is a self-granted standing
 * approval), via protectedPaths below. Note the fs tools already confine
 * paths to the cwd - this is the explicit wall for the in-cwd case (.env) and
 * defense in depth for the rest.
 */
function secretStatePaths(): string[] {
  return [paths.state, paths.vault, approvalsDbPath(), resolve('.env')];
}

import { appendEvent } from './agenda/write.js';
import { type AlertInbox, startAlertInbox } from './alerts/inbox.js';
import { approvals } from './approvals/broker.js';
import { verifyCallAudit } from './audit/calls.js';
import { SecretLibrary } from './books/secret.js';
import { cacheFullReply, isMoreRequest, takeFullReply } from './channels/telegram.js';
import { dailyBudgetExceeded, recordUsage } from './core/usage.js';
import { parseMcpServers } from './mcp/client.js';
import { createMcpTools } from './mcp/tools.js';
import { OwnerProfile } from './memory/profile.js';
import { buildMemoryPromptSection } from './memory/prompt.js';
import {
  currentLimits,
  getPace,
  paceText,
  parsePace,
  recordDismissal,
  setPace,
} from './notice-pace.js';
import { DESKTOP_OFF_MESSAGE, desktopEnabled, toolsForMode } from './platform.js';
import {
  buildMacroPrompt,
  canonicalMacroName,
  detectMacroParams,
  isMacroName,
  parseMacroArgs,
  procedurePrompt,
  type RoutineRunContext,
  RoutineRunner,
  summarizeRoutine,
  validateSchedule,
} from './routines.js';
import {
  captureCameraFrame,
  consumeRecording,
  listCaptureDevices,
  recordCamera,
  recordCameraWithMic,
  recordMicrophone,
  toPlayableAudio,
} from './screen/media.js';
import { ocrAvailable, ocrImage } from './screen/ocr.js';
import { ffmpegAvailable, recordScreen } from './screen/recorder.js';
import { hasInteractiveDesktop, WindowsScreen } from './screen/windows.js';
import { fetchSkillMarkdown, installSkill } from './skills/import.js';
import { recordLessons, skillsIndex } from './skills/lessons.js';
import { SkillStore } from './skills/store.js';
import { formatStatus, summarizeLog } from './status.js';
import { steerChat } from './steer.js';
import { createAgendaTool } from './tools/agenda.js';
import { createBookTool } from './tools/book.js';
import { createBrowserTool } from './tools/browser.js';
import { createCalendarTool } from './tools/calendar.js';
import { checkoutStageOf, createCheckoutPage, createCheckoutTool } from './tools/checkout.js';
import { createComputerTool } from './tools/computer.js';
import { createDecisionTool } from './tools/decision.js';
import { createDocsTool } from './tools/docs.js';
import { createAskTool, createDoneTool } from './tools/done.js';
import { createDownloadTool } from './tools/download.js';
import { createFactoryTool } from './tools/factory.js';
import { createFetchTool, fetchPage, isFetchableResolved } from './tools/fetch.js';
import { fsTools } from './tools/fs.js';
import { createGestionTool } from './tools/gestion.js';
import { createGoalTool } from './tools/goal.js';
import type { IphoneToolDeps } from './tools/iphone.js';
import { createIphoneTool } from './tools/iphone.js';
import { createMediaTool } from './tools/media.js';
import { createMemoryTool } from './tools/memory.js';
import { createOcrTool } from './tools/ocr.js';
import { createOpenGymTool, type GymKind, gymAnswer } from './tools/opengym.js';
import {
  createReminderTool,
  deliverMissedReminders,
  isOneShotReminder,
  isReminder,
  oneShotStillPending,
  readDroppedReminders,
  recordDroppedReminder,
  reminderText,
  settleOneShot,
} from './tools/reminder.js';
// Renfe stays unregistered on purpose: a tool that only knows one site lets the agent
// report a booking it never made, which is the exact failure this project exists to
// remove. The generic browser does the same job against any site.
import { createShellTool } from './tools/shell.js';
import { createSkillsTool } from './tools/skills.js';
import { createSystemTool, playAudioFile, playbackRestoreText } from './tools/system.js';
import type { TvMemoryState, TvToolDeps } from './tools/tv.js';
import { createTvTool } from './tools/tv.js';
import { buildWebBackends, createWebTool } from './tools/web.js';
import { createWindowsTool, listWindows } from './tools/windows.js';
import { startTvButtonListener, type TvButtonListener } from './tv/button-listener.js';
import { GlasshouseClient, GlasshouseUnavailableError } from './tv/glasshouse.js';
import { tvKey, tvRequest, tvScreenshot, tvToast } from './tv/lgtv.js';
import { setUndoDir, undoLast } from './undo.js';
import { Mutex, plainInline } from './utils.js';
import {
  initVault,
  unlock,
  vaultDelete,
  vaultExists,
  vaultGet,
  vaultList,
  vaultSet,
} from './vault.js';
import {
  getOjoEnabled,
  isOwnerDm,
  resolveOwnerDmChatId,
  resolveOwnerUserId,
  setOjoEnabled,
  startVigilanteLoop,
} from './vigilante.js';
import { createAloudSpeaker } from './voice/aloud.js';
import { BargeStats, bargeClassified, bargeFalseRate } from './voice/barge-stats.js';
import { createBargeVadScorer } from './voice/barge-vad.js';
import { type BargeInLevel, ConversationSession } from './voice/conversation.js';
import { splitPhrases } from './voice/phrases.js';
import { createMciSpeaker, type Playback } from './voice/speaker.js';
import { SpeakerVerifier, speakerGateConfigFromEnv } from './voice/speaker-verify.js';
import { transcribeVoiceNote } from './voice/stt.js';
import { createSapiTts } from './voice/tts.js';
import { speakerProfilesFile } from './voice/voice-cli.js';
import { defaultTranscriber, stripWakeWord, WakeWordListener } from './voice/wake.js';
import { compareProduct, describeCompare } from './watch/compare.js';
import {
  describeChange,
  describeWatch,
  eur,
  PageWatchStore,
  parseVigilaArgs,
} from './watch/pages.js';
import { startPricewatchLoop } from './watch/pricewatch-loop.js';
import { realDeps } from './watch/pricewatch-runner.js';
import { WebRouter } from './web/router.js';
import { createOwnerGoalsReader } from './webui/goals.js';
import { startWebUi } from './webui/server.js';
import { buildWeeklySummary, isWeeklyDue, WeeklyState } from './weekly.js';

const USAGE = `personal-agent - a personal agent for your own PC

Usage:
  pa setup                configuración local guiada, sin red ni autostart
  pa serve                run the daemon: Telegram, with approvals over chat
  pa chat                 talk to the agent in the console
  pa run "<prompt>"       run one prompt unattended (read-only tools, no prompts)
  pa vault init           create the encrypted secret store
  pa vault set <k> <v>    store a secret
  pa vault set-stdin <k>  guardar secreto desde pipe privado, sin valor en argv
  pa vault get <k>        print one secret
  pa vault list           list secret names (never values)
  pa vault rm <k>         delete a secret
  pa books setup          conectar tu Telegram para la entrega de libros (pagina local, una vez)
  pa tv setup <ip>        emparejar la LG webOS (acepta el aviso en la tele, una vez)
  pa tv toast <mensaje>   mostrar un aviso en la tele
  pa tv apps              listar apps instaladas (ids para pa tv launch)
  pa tv launch <appId>    lanzar una app en la tele
  pa tv key <NOMBRE>      pulsar una tecla del mando (HOME, BACK, ENTER, UP/DOWN/LEFT/RIGHT)
  pa tv shot [fichero]    capturar la pantalla de la tele (960x540 jpg; DRM sale en negro)
  pa tv off               apagar la tele
  pa opengym pair [url] <code>   pair openGym (read-only gym tracker)
  pa opengym status       check the openGym connection
  pa evolve [--idea <text>]  one self-improvement cycle on this git checkout (needs PA_EVOLVE_PROPOSER)
  pa autostart install|status|uninstall [--start] [--what-if] [--no-local-llm]
  pa status [--json]      estado puntual del PID y latido, sin cambiar el daemon
  pa watchdog --status [--json]  consulta puntual; no instala ni activa vigilancia
  pa diagnose [--json]    diagnóstico local del daemon, sin arrancarlo ni reiniciarlo
  pa stop                 Linux: cierre graceful autenticado, sin matar por PID
  pa restart              no disponible sin verificar supervisor
  pa doctor               check the environment
  pa llm-health           probe each configured LLM provider (ok/auth/cuota/timeout/sin-key)
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

import { booksSetupCommand } from './books/setup-cli.js';
import { tvCommand } from './tv/tv-cli.js';

export async function main(argv: string[]): Promise<number> {
  const [command = 'chat', ...rest] = argv;

  switch (command) {
    case 'setup': {
      const { setupCommand } = await import('./setup.js');
      return setupCommand(rest);
    }
    case 'vault':
      return vaultCommand(rest);
    case 'opengym':
      return openGymCommand(rest);
    case 'books':
      if (rest[0] !== 'setup') {
        process.stderr.write('uso: pa books setup' + '\n');
        return 2;
      }
      try {
        await booksSetupCommand();
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
      return new Promise<number>(() => {});
    case 'tv':
      return tvCommand(rest);
    case 'voice': {
      const { voiceCommand } = await import('./voice/voice-cli.js');
      return voiceCommand(rest);
    }
    case 'status': {
      const { statusCommand } = await import('./daemon-status.js');
      return statusCommand(rest);
    }
    case 'autostart': {
      const { autostartCommand } = await import('./autostart.js');
      return autostartCommand(rest);
    }
    case 'autostart-notify': {
      const { notifyAutostart } = await import('./autostart.js');
      return rest.length === 1 ? notifyAutostart(rest[0] ?? '') : 2;
    }
    case 'watchdog': {
      if (rest[0] !== '--status') {
        process.stderr.write(
          'uso: pa watchdog --status [--json] (solo consulta; no activa vigilancia)\n',
        );
        return 2;
      }
      const { statusCommand } = await import('./daemon-status.js');
      return statusCommand(rest.slice(1));
    }
    case 'diagnose': {
      const { diagnoseCommand } = await import('./diagnose-cli.js');
      return diagnoseCommand(rest);
    }
    case 'doctor':
      return doctorCommand();
    case 'llm-health':
      return llmHealthCommand();
    case 'evolve':
      return evolveCommand(rest);
    case 'chat':
      return controlledDaemon(chatCommand);
    case 'serve':
      return controlledDaemon(serveCommand);
    case 'stop': {
      if (rest.length) {
        process.stderr.write('uso: pa stop\n');
        return 2;
      }
      const { stopDaemon } = await import('./daemon-control.js');
      const result = await stopDaemon(paths.state);
      process.stdout.write(
        `Instancia ${result.instanceId.slice(0, 12)} detenida con cierre limpio confirmado.\n`,
      );
      return 0;
    }
    case 'restart':
      process.stderr.write(
        'Restart no disponible: no se puede verificar si un supervisor volverá a lanzar el daemon. No se ha detenido ni arrancado ningún proceso.\n',
      );
      return 2;
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

/**
 * One self-improvement cycle, run by hand on a clean git checkout (the VM, a laptop).
 *
 * `/evolucion ahora` does the same from Telegram inside the daemon. This exists because the
 * loop needs the repo (it works in git worktrees), which a packaged container does not have.
 * Nothing it finds is merged: a promoted attempt is a branch and a patch for a normal PR.
 */
async function evolveCommand(args: string[]): Promise<number> {
  ensureDirs();
  const i = args.indexOf('--idea');
  const idea = i >= 0 ? args.slice(i + 1).join(' ') : '';
  try {
    if (idea.trim()) addHypothesis(paths.state, idea);
    const out = await runEvolution({
      stateDir: paths.state,
      log: (m) => process.stderr.write(`${m}\n`),
    });
    process.stdout.write(`${out.text}\n`);
    return out.report || !process.env.PA_EVOLVE_PROPOSER ? 0 : 1;
  } catch (err) {
    process.stderr.write(`evolve: ${(err as Error).message}\n`);
    return 1;
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
  if (args[0] === 'set-stdin') {
    const { setVaultFromStdin } = await import('./vault-stdin.js');
    await setVaultFromStdin(args.slice(1), process.stdin, async (key, value) => {
      ensureDirs();
      await vaultSet(key, value);
    });
    process.stdout.write('Secreto guardado. No se muestra su valor.\n');
    return 0;
  }
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
  if (desktopEnabled()) {
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
  } else {
    lines.push(
      'desktop         off (modo servidor, PA_DESKTOP=off): sin chequeos de escritorio Windows',
    );
  }

  const chromiumDir = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  lines.push(
    `browser         ${existsSync(chromiumDir) ? 'chromium installed' : 'MISSING (run: npx playwright install chromium)'}`,
  );
  lines.push(`cron            ${loadConfig().cron.length} schedule(s) from PA_CRON`);
  lines.push(
    `verify actions  ${loadConfig().verifyActions ? 'on (2 extra screenshots per input action)' : 'off'}`,
  );

  if (desktopEnabled()) {
    const windows = await listWindows().catch(() => []);
    lines.push(
      `open windows    ${windows.length ? windows.map((w) => w.title).join(' | ') : 'none detected'}`,
    );
  }

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
 * Where the standing human approvals are kept.
 *
 * Its own file rather than `paths.db`, for the same reason `memory.db` is separate
 * from the transcript: `Store` holds a WAL connection open on `paths.db` for the
 * whole process while the gate opens the file for the length of a single write, and
 * a second writer with no busy timeout gets `SQLITE_BUSY` instead of waiting. That
 * failure is silent and bad: raised inside the approver it converts the user's tap on
 * "Siempre" into a refusal, and raised in the gate constructor it throws while a
 * conversation is being created. A file nothing else writes to has neither problem.
 */
export function approvalsDbPath(stateDir: string = paths.state): string {
  return join(stateDir, 'approvals.db');
}

export interface DaemonGateOptions {
  /** The conversation these approvals belong to: `chatKey#thread`. */
  threadKey: string;
  /**
   * File the `always` scopes are written to and read back from. Required rather than
   * optional: forgetting it is precisely the bug this wiring exists to fix, and it is
   * invisible from the outside - the daemon keeps asking forever and looks healthy.
   */
  dbPath: string;
  /** Vault opt-in (`agent:fullControl`): unattended, except money and credentials. */
  fullControl?: boolean;
  /**
   * Publish the question and wait for the human.
   *
   * The answer carries the scope, so the choice is applied here, where it arrives:
   * `setScope` writes to disk before the tool call it just authorised even returns,
   * and the next call of the same tool is already covered.
   */
  ask: (
    threadKey: string,
    tool: string,
    reason: string,
    question?: string,
  ) => Promise<ApprovalChoice>;
  /**
   * Told while a human is being asked, because the idle watchdog has to know that
   * waiting for a person is not a stall. Optional so callers without a watchdog can
   * ignore it.
   */
  onAwaiting?: (waiting: boolean) => void;
}

/**
 * The gate the daemon arms for a conversation.
 *
 * Extracted from the daemon's closure so the whole policy - the allow list, the
 * protected paths, and above all the file the standing grants live in - can be
 * exercised without a Telegram token and a desktop. The wiring is the part that
 * breaks; the gate itself was fine.
 *
 * Approval scope has two widths, and the difference is the whole point of this file.
 * `session` and `once` die with the turn (`clearSession` at the end of every turn),
 * because approval scope is one task and never the next one. `always` is the user's
 * standing decision about a tool, so it is written to `dbPath` keyed by tool alone:
 * global, and read back by every conversation in every chat on the next run. Keying it
 * per conversation instead would be indistinguishable to the user from not persisting
 * it at all - the next message arrives in a new thread and asks again - and it would
 * silently widen into a global grant the moment two threads shared a session id.
 *
 * `always` is never consulted for money or credentials; that exclusion lives in
 * `Gate.check` and is not this file's to weaken. The same goes for the purchase charge:
 * `allowUntilPayment` lets a purchase reach its payment screen unattended and stops
 * there, because the one thing a standing grant must never be is "always pays".
 */
export function createDaemonGate(options: DaemonGateOptions): Gate {
  // The approver closes over `gate`, which is the line being executed here, so the
  // reference is live before any tool call can reach it. An approver cannot run before
  // the agent that owns this gate exists, so a holder indirection would be noise.
  const gate = new Gate({
    // The whole read-only toolset rather than a hand-kept list, so a tool added on main
    // is usable from a thread without editing this line.
    allow: THREAD_ALLOW_TOOLS,
    allowActions: [
      'computer:screenshot',
      'computer:move',
      // Navigating and operating a page does not ask: the gate still asks first for
      // money, credential fields and sending/deleting/booking elements, and exec_js
      // (arbitrary code) is not in the list.
      ...BROWSER_FREE_ACTIONS,
      // Playing audio the user already sent, and listing what is stored, are the
      // two media actions the prompt promises free ("needs no permission"). The
      // camera, the microphone and screen recording still ask, every time.
      'media:play',
      'media:list_audio',
    ],
    // Autonomous up to the last click. A purchase is a chain of ordinary browsing
    // actions, and asking about each of them is what stopped the Renfe flow before it
    // bought anything. The stage of a call is read from `checkoutStageOf`, a five-row
    // table in the tool itself, and the rules that survive this flag are in
    // permissions.ts: money, credentials, the deny list and `confirm`, which always
    // asks.
    allowUntilPayment: true,
    stageOf: checkoutStageOf,
    fullControl: options.fullControl ?? false,
    protectedPaths: protectedPaths(),
    secretPaths: secretStatePaths(),
    maxAmountCents: 30_000,
    grantWindowMs: 90_000,
    // The load-bearing line. Without it every "Siempre" dies with the process and an
    // always-on daemon re-asks for exactly what it was told never to ask again.
    dbPath: options.dbPath,
    // Approvals travel back over Telegram as inline buttons, and the idle watchdog is
    // paused while one is parked. The buttons also carry the scope: "siempre" must
    // mean always, not once per task.
    approver: async (call, reason) => {
      options.onAwaiting?.(true);
      try {
        const approval = formatApproval(call, reason);
        if (!approval.complete) {
          // Fail-closed: si la accion no cabe entera en la pregunta se deniega,
          // en vez de dejar aprobar a ciegas algo que no se ha mostrado entero.
          log.error('approval denied: action not fully displayable', {
            tool: call.tool,
            questionChars: approval.question.length,
          });
          return false;
        }
        const choice = await options.ask(options.threadKey, call.tool, reason, approval.question);
        if (choice.approved && choice.scope !== 'once') {
          try {
            gate.setScope(options.threadKey, call.tool, choice.scope);
          } catch (err) {
            // A grant that could not be written is a nuisance; losing the call the
            // user just approved because of it would be a bug. Carry on, and say so:
            // the next run will ask again rather than pretend the grant survived.
            log.error('approval scope not saved', {
              tool: call.tool,
              scope: choice.scope,
              dbPath: options.dbPath,
              ...redact({ err }),
            });
          }
        }
        return choice.approved;
      } finally {
        options.onAwaiting?.(false);
      }
    },
  });
  return gate;
}

/**
 * The vertical slice: one agent, console input, gate armed, tools registered.
 * Everything else (channels, scheduler) plugs in behind this same shape.
 */
/**
 * Cableado de la tool `iphone` al servidor hidagent (esp32-iphone-agent).
 * La URL vive en el vault (iphone:url) o en PA_IPHONE_URL. Sin ella, cada
 * accion falla con un mensaje legible: el telefono es opcional y su ausencia
 * no puede tumbar el arranque.
 */
function iphoneToolDeps(): IphoneToolDeps {
  const client = async (): Promise<IphoneClient> => {
    const url = (await vaultGet('iphone:url')) || process.env.PA_IPHONE_URL?.trim();
    if (!url) {
      throw new Error(
        'El puente del iPhone no esta configurado: guarda su URL en el vault (iphone:url) o PA_IPHONE_URL. Ver deploy/iphone/README.md.',
      );
    }
    return new IphoneClient({ baseUrl: url });
  };
  return {
    status: async () => (await client()).status(),
    frame: async () => (await client()).frame(),
    start: async (goal) => (await client()).start(goal),
    stop: async () => (await client()).stop(),
    home: async () => (await client()).home(),
  };
}

/**
 * Cableado de la tool `tv` al cliente SSAP real.
 *
 * La emparejacion vive en el vault (tv:host / tv:clientKey / tv:secure), escrita
 * por `pa tv setup`. Si no hay pairing, TODAS las acciones fallan aqui con un
 * mensaje que el modelo puede leer, en vez de romper el arranque del agente: la
 * tele es opcional y su ausencia no puede tumbar el resto.
 */
function tvToolDeps(store: Store): TvToolDeps {
  const frameDir = join(paths.screenshots, 'tv');
  mkdirSync(frameDir, { recursive: true });
  const STATE_KEY = 'tv:lastLook';

  const paired = async (): Promise<{
    host: string;
    clientKey: string;
    allowPlaintext: boolean;
  }> => {
    const host = await vaultGet('tv:host');
    const clientKey = await vaultGet('tv:clientKey');
    if (!host || !clientKey) {
      throw new Error(
        'La tele no esta emparejada. Emparejala una vez con: pa tv setup <ip-de-la-television>',
      );
    }
    return { host, clientKey, allowPlaintext: (await vaultGet('tv:secure')) === '0' };
  };

  /**
   * Glasshouse (API :8080 de la tele rooteada): via primaria para volumen
   * absoluto, inputs, url, closeApp, picture y privacidad, y transporte
   * preferente de launch/toast/power. Default: LAN primero, tailnet de
   * fallback (el nodo tailscale de la tele tarda en volver tras un reinicio).
   * Override con vault tv:glasshouseUrl (lista separada por comas) y token
   * con tv:glasshouseToken. Los endpoints invalidos fallan al CONSTRUIR el
   * cliente, en la llamada - nunca en el arranque del agente.
   */
  const GH_DEFAULT_ENDPOINTS = ['http://192.168.1.237:8080', 'http://100.126.88.124:8080'];
  const ghClient = async (): Promise<GlasshouseClient> => {
    const override = await vaultGet('tv:glasshouseUrl');
    const endpoints = override?.trim()
      ? override
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : GH_DEFAULT_ENDPOINTS;
    return new GlasshouseClient({ endpoints, token: await vaultGet('tv:glasshouseToken') });
  };

  return {
    shot: async () => {
      const { host, clientKey, allowPlaintext } = await paired();
      const image = await tvScreenshot(host, clientKey, { allowPlaintext });
      // El mime/ext salen de la FIRMA real del frame: la tele decide el
      // formato, no el cliente (tvScreenshot acepta JPEG y PNG).
      const jpeg = image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
      const png = image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4e && image[3] === 0x47;
      if (png) return { image, mimeType: 'image/png', ext: 'png' };
      if (jpeg) return { image, mimeType: 'image/jpeg', ext: 'jpg' };
      return { image, mimeType: 'application/octet-stream', ext: 'bin' };
    },
    foreground: async () => {
      const { host, clientKey, allowPlaintext } = await paired();
      const res = await tvRequest(
        host,
        clientKey,
        'com.webos.applicationManager/getForegroundAppInfo',
        {},
        { allowPlaintext },
      );
      const p = res as { appId?: string; appCategory?: string[] };
      return { appId: p.appId ?? 'desconocida', category: p.appCategory ?? [] };
    },
    apps: async () => {
      const { host, clientKey, allowPlaintext } = await paired();
      const res = await tvRequest(
        host,
        clientKey,
        'com.webos.applicationManager/listLaunchPoints',
        {},
        { allowPlaintext },
      );
      const points = (res as { launchPoints?: { id: string; title: string }[] }).launchPoints ?? [];
      return points.map((p) => ({ id: p.id, title: p.title }));
    },
    launch: async (id) => {
      // Glasshouse primero (sin pairing); si la tele no lo tiene o no
      // responde, SSAP con la client-key guardada.
      try {
        await (await ghClient()).control('launchApp', id);
        return;
      } catch (err) {
        // Fallback a SSAP SOLO si Glasshouse no llego a recibir la orden
        // (conexion nunca establecida). Un rechazo (ok:false, 4xx/5xx,
        // allowPower=false) o una escritura ambigua JAMAS se repiten por
        // otro transporte: respetan la config de la tele (auditor #104 r1).
        if (!(err instanceof GlasshouseUnavailableError)) throw err;
        log.info('tv launch: Glasshouse inalcanzable, pruebo SSAP', { err: String(err) });
      }
      const { host, clientKey, allowPlaintext } = await paired();
      await tvRequest(host, clientKey, 'system.launcher/launch', { id }, { allowPlaintext });
    },
    key: async (name) => {
      const { host, clientKey, allowPlaintext } = await paired();
      await tvKey(host, clientKey, name, { allowPlaintext });
    },
    toast: async (message) => {
      try {
        await (await ghClient()).control('toast', message);
        return;
      } catch (err) {
        // Fallback a SSAP SOLO si Glasshouse no llego a recibir la orden
        // (conexion nunca establecida). Un rechazo (ok:false, 4xx/5xx,
        // allowPower=false) o una escritura ambigua JAMAS se repiten por
        // otro transporte: respetan la config de la tele (auditor #104 r1).
        if (!(err instanceof GlasshouseUnavailableError)) throw err;
        log.info('tv toast: Glasshouse inalcanzable, pruebo SSAP', { err: String(err) });
      }
      const { host, clientKey, allowPlaintext } = await paired();
      await tvToast(host, clientKey, message, { allowPlaintext });
    },
    power: async (on) => {
      // Glasshouse powerOn/powerOff exige allowPower en la config de la tele.
      // SSAP solo si Glasshouse no llego a recibir la orden; si responde con
      // rechazo (allowPower=false) se respeta la config y se propaga el error.
      try {
        await (await ghClient()).control(on ? 'powerOn' : 'powerOff');
        return;
      } catch (err) {
        // Fallback a SSAP SOLO si Glasshouse no llego a recibir la orden
        // (conexion nunca establecida). Un rechazo (ok:false, 4xx/5xx,
        // allowPower=false) o una escritura ambigua JAMAS se repiten por
        // otro transporte: respetan la config de la tele (auditor #104 r1).
        if (!(err instanceof GlasshouseUnavailableError)) throw err;
        log.info('tv power: Glasshouse inalcanzable, pruebo SSAP', { err: String(err) });
      }
      const { host, clientKey, allowPlaintext } = await paired();
      if (on) {
        await tvRequest(
          host,
          clientKey,
          'com.webos.service.tvpower/power/turnOnScreen',
          {},
          { allowPlaintext },
        );
        return;
      }
      await tvRequest(host, clientKey, 'system/turnOff', {}, { allowPlaintext });
    },
    stats: async () => (await ghClient()).getJson('/api/stats'),
    ghControl: async (action, value) => {
      await (await ghClient()).control(action, value);
    },
    saveFrame: (bytes, ext) => {
      // UUID + wx: dos agentes (o dos capturas en el mismo ms) nunca pisan el
      // frame del otro, y el recuerdo apunta siempre a SUS bytes.
      const file = join(frameDir, `tv-${randomUUID()}.${ext}`);
      writeFileSync(file, bytes, { flag: 'wx' });
      return file;
    },
    getState: () => {
      const raw = store.kvGet(STATE_KEY);
      if (!raw) return null;
      try {
        // kv es disco, no memoria: validar la ESTRUCTURA antes de fiarse.
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const s = parsed as Record<string, unknown>;
        if (
          typeof s.appId !== 'string' ||
          !Array.isArray(s.category) ||
          !s.category.every((c) => typeof c === 'string') ||
          typeof s.at !== 'string' ||
          typeof s.framePath !== 'string' ||
          typeof s.bytes !== 'number'
        ) {
          return null;
        }
        return s as unknown as TvMemoryState;
      } catch {
        // kv corrupto: se descarta en silencio y se vuelve a mirar la tele.
        return null;
      }
    },
    setState: (state) => {
      store.kvSet(STATE_KEY, JSON.stringify(state));
    },
  };
}

async function chatCommand(control?: ControlStartup): Promise<number> {
  ensureDirs();
  const config = loadConfig();

  if (!vaultExists()) {
    process.stderr.write('no vault yet. run: pa vault init\n');
    return 1;
  }
  await unlock();

  // Refuse to run twice: a second instance sharing channel credentials gets logged out.
  assertNotRunning(paths.state, 'agent');

  control?.beginResources();
  const store = new Store();
  store.sweepExpired();

  const gate = new Gate({
    allow: ['read', 'list', 'fetch', 'done'],
    // Reading the screen and reading a public web page are not changes to the world, so
    // approval. Acting on it does.
    allowActions: ['computer:screenshot', 'computer:move'],
    protectedPaths: protectedPaths(),
    secretPaths: secretStatePaths(),
    maxAmountCents: 30_000,
    // Reads the same standing grants the daemon writes, and nothing more: the console
    // has no scope buttons, so it never records one. They apply here because "always"
    // is a statement about the tool, not about the process that happened to ask.
    dbPath: approvalsDbPath(),
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
  let factorySyncLocal: () => Promise<void> = async () => {};
  const tools: AgentTool[] = [
    ...fsTools,
    createFetchTool(),
    createWebTool(config),
    createDoneTool(),
    createAskTool(),
    createFactoryTool({ onChange: () => void factorySyncLocal() }),
    createShellTool(config),
    createComputerTool(config, screen, (call) =>
      gate.check(sessionId, { ...call, actor: 'asistenta' }),
    ),
  ] as AgentTool[];

  const agent = await PersonalAgent.create(config, tools, gate, 'local', { sessionId });
  factorySyncLocal = createFactorySync(
    (t) => agent.registerFactoryTool(t),
    (n) => agent.unregisterFactoryTool(n),
  );
  await factorySyncLocal();

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  let activeTurn: Promise<unknown> | undefined;
  const lifecycle = installLifecycle({
    name: 'agent',
    onShutdown: async () => {
      agent.abort('external');
      rl.close();
      await activeTurn?.catch(() => {});
      await screen.dispose();
      store.close();
      log.info('shutdown complete');
    },
  });

  control?.attach(lifecycle);
  control?.ready();
  rl.prompt();

  for await (const line of rl) {
    const text = line.trim();
    if (text === '/quit' || text === '/exit') break;
    if (!text) {
      rl.prompt();
      continue;
    }
    try {
      const pending = agent.run(text);
      activeTurn = pending;
      const result = await pending;
      activeTurn = undefined;
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
    protectedPaths: protectedPaths(),
    secretPaths: secretStatePaths(),
    maxAmountCents: 30_000,
    // Unattended one-shot run: there is no human at the keyboard, so anything that
    // would need approval is refused rather than guessed at. Screenshot and read
    // stay available, which is enough for reconnaissance without letting the agent
    // change anything.
    //
    // No dbPath on purpose. `pa run` is documented as unattended and read-only: it has
    // no approver, so a standing `always` for `shell` granted over Telegram would turn
    // a deliberate refusal here into silent command execution. The standing grants
    // belong to the modes where a human is present to make them.
    approver: undefined,
  });
  const screen = new WindowsScreen();
  // Same wiring as chatCommand: the batch gate has to share the agent's session so
  // sub-actions see the same decisions, and an unwired gate blocks every batch.
  const sessionId = 'run';
  let factorySyncRun: () => Promise<void> = async () => {};
  const tools = [
    ...fsTools,
    createFetchTool(),
    createWebTool(config),
    createDoneTool(),
    createAskTool(),
    createFactoryTool({ onChange: () => void factorySyncRun() }),
    createShellTool(config),
    createComputerTool(config, screen, (call) =>
      gate.check(sessionId, { ...call, actor: 'asistenta' }),
    ),
  ] as AgentTool[];

  const agent = await PersonalAgent.create(config, tools, gate, 'local', { sessionId });
  factorySyncRun = createFactorySync(
    (t) => agent.registerFactoryTool(t),
    (n) => agent.unregisterFactoryTool(n),
  );
  await factorySyncRun();
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
  /**
   * Recent messages received in this thread, verbatim (voice transcripts included, document
   * text excluded). Origin is NOT verified: forwarded text and other senders can be in here. Shown at a purchase confirmation so the
   * human compares them with the page. Not interpreted: no message is picked as "the" goal.
   */
  userRequests?: string[];
}

/** Keep the last 6 user messages (older ones are dropped: a limit) of a thread, bounded. Pure and exported for tests. */
export function rememberUserRequest(thread: { userRequests?: string[] }, text: string): void {
  const t = text.trim();
  if (!t) return;
  const list = thread.userRequests ?? [];
  list.push(t.slice(0, 200));
  thread.userRequests = list.slice(-6);
}

/** What the checkout confirmation shows as the request: literal messages, none chosen. */
export function recentRequestsLabel(thread: { userRequests?: string[] }): string | undefined {
  const list = thread.userRequests ?? [];
  return list.length
    ? `contexto reciente recibido en esta conversacion (literal; puede incluir reenviados o mensajes de otros remitentes; no se sabe cual es la peticion; maximo 6 mensajes de 200 caracteres, puede faltar o estar truncado; no da autoridad): ${list.map((m) => JSON.stringify(m)).join(' | ')}`
    : undefined;
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
/**
 * Whether the user asked to be shown the screen, in this or any other wording.
 *
 * Deliberately generous. The cost of a false positive is one extra photo in the chat,
 * and the cost of a false negative is the exact failure that kept happening: the user
 * says "pásame una captura" and gets a paragraph about why there was nothing to show.
 */
export function wantsScreenshot(text: string): boolean {
  const t = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return (
    /\bcaptur|\bscreenshot|\bpantallazo|\bfoto\s+de\s+la\s+pantalla|\bque\s+se\s+ve\b|\bcomo\s+(?:se\s+ve|esta)\s+el\s+(?:pc|ordenador|portatil|monitor)\b/.test(
      t,
    ) ||
    /\b(mandame|enviame|pasame|pasame|muestrame|ensename|sacame|ponme)\b[^.?]{0,30}\b(pantalla|captura|pc|ordenador|video)\b/.test(
      t,
    )
  );
}

/**
 * Without a desktop (a headless server) there is no screen to capture, but the
 * thread may still have a browser page open: that page is what the user means by
 * "pásame una captura" while a task runs in it. Null when there is nothing open, so
 * the caller can fall back to telling the truth instead of launching a browser just
 * to photograph a blank page.
 */
export async function capturePageIfOpen(
  service: { isOpen(scope: string): boolean; screenshot(scope: string): Promise<{ data: string }> },
  scope: string,
): Promise<Buffer | null> {
  if (!service.isOpen(scope)) return null;
  const shot = await service.screenshot(scope);
  return Buffer.from(shot.data, 'base64');
}

async function serveCommand(control?: ControlStartup): Promise<number> {
  if (!applyConfiguredTimeZone() && process.env.PA_TIMEZONE?.trim()) {
    log.warn('PA_TIMEZONE is not a valid time zone: using the system one', {
      value: process.env.PA_TIMEZONE,
    });
  }
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

  // Resolve credentials before announcing readiness or creating a thread.
  // Provider construction does not issue a billable model request.
  try {
    await createProviderHandle(config);
    if (process.env.PA_QA_CHANNEL !== '1') await checkTelegramToken(token);
  } catch (error) {
    const message =
      (error instanceof Error && error.message.startsWith('Telegram')) ||
      (error instanceof Error && /^(El token|No puedo conectar)/.test(error.message))
        ? error.message
        : startupFailureMessage(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }

  assertNotRunning(paths.state, 'agent');
  control?.beginResources();
  const store = new Store();
  store.sweepExpired();
  const memory = new MemoryStore();
  const docMemory = new DocMemory({
    dbPath: join(paths.docs, 'docs.sqlite'),
    directory: join(paths.docs, 'mirror'),
  });
  /**
   * The one file the gates of every conversation read their standing approvals from.
   *
   * Computed once and shared: the point is that it is the same path for all of them.
   * A per-thread file would make "Siempre" survive a restart while still asking again
   * on the next message, which is exactly the behaviour that made the button useless.
   */
  const approvalsDb = approvalsDbPath();

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
  setUndoDir(join(paths.state, 'undo'));
  const memoryDb = new DatabaseSync(join(paths.state, 'memory.db'));
  const goalsDb = new DatabaseSync(join(paths.state, 'goals.db'));
  memoryDb.exec('PRAGMA journal_mode = WAL');
  memoryDb.exec('PRAGMA busy_timeout = 5000');
  const sessions = new SessionStore({ db: memoryDb });
  const instincts = new InstinctStore({ db: memoryDb });
  const workstreams = new WorkstreamStore({ db: memoryDb });
  const decisionLedger = new DecisionLedger(memoryDb, workstreams);
  const followups = new FollowupTracker({ db: memoryDb });
  const pageWatches = new PageWatchStore(memoryDb);
  const weeklyState = new WeeklyState(memoryDb);
  const voiceDb = new DatabaseSync(join(paths.state, 'voice.db'));
  const bargeStats = new BargeStats(voiceDb);
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
  // S5 (opt-in PA_SEMANTIC_RECALL=1): embeddings locales para recall híbrido.
  const semanticRecall = semanticFromEnv(paths.models);
  // Modelo de usuario que se enriquece solo: cuenta repeticiones de nudges.
  const nudgeTracker = new NudgeTracker(join(paths.state, 'snapshot'));
  const skills = new SkillStore({ dir: join(paths.state, 'skills') });
  const playbooks = new PlaybookStore({ dir: join(paths.state, 'playbooks') });
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
  /** Dia (YYYY-MM-DD) del ultimo aviso de presupuesto diario agotado. */
  let budgetWarnedDay = '';

  const fullControl = (await vaultGet('agent:fullControl')) === 'true';
  const ocrAvailability = desktop ? await ocrAvailable().catch(() => false) : false;
  const voiceDefault = (await vaultGet('agent:voice')) !== 'off';

  // Originals are kept in private state/media for the recall TTL and chat cap.
  // Handles and originals survive restart; no other chat can resolve them.
  const recall = new AudioRecall({ directory: join(paths.state, 'media', 'received') });

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
    // A spoken session cannot survive its microphone being taken away.
    if (wasRunning) endSession('apagado');
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
  // --- Integraciones opcionales del daemon -----------------------------------
  // MCP: servidores externos (PA_MCP_SERVERS) se arrancan UNA vez y sus tools
  // entran en todos los hilos. Un servidor caído se salta y no impide arrancar.
  const mcpServers = parseMcpServers(process.env.PA_MCP_SERVERS);
  const mcpTools = mcpServers.length
    ? await createMcpTools(mcpServers).catch((err: unknown) => {
        log.warn('mcp: no se pudieron arrancar los servidores', { err });
        return [] as AgentTool[];
      })
    : [];
  if (mcpTools.length)
    log.info('mcp: tools listas', { servers: mcpServers.length, tools: mcpTools.length });
  const panelGoals = createOwnerGoalsReader();
  // Panel web local (PWA): solo si se pide con PA_WEB_PORT y hay token. Loopback.
  if (process.env.PA_WEB_PORT) {
    const webToken = process.env.PA_WEB_TOKEN;
    if (!webToken) log.warn('PA_WEB_PORT sin PA_WEB_TOKEN: panel web no arrancado');
    else {
      void startWebUi(
        {
          token: webToken,
          goals: () => panelGoals.read(),
          status: () => ({
            model: config.model,
            provider: config.provider,
            threads: threads.size,
            uptimeSeconds: Math.round(process.uptime()),
          }),
          sessions: (q?: string) => (q ? sessions.search(q) : sessions.recent(undefined, 20)),
          memory: (scope?: string) => memory.all(scope ?? 'local'),
          auditVerify: () => verifyCallAudit(),
          // Chat del panel: corre en el hilo principal del propietario, con el
          // mismo agente, contexto y Gate que Telegram (sin enviar nada al chat).
          chat: async (text: string) => {
            const thread = await getOrCreateThread(
              'telegram:dm:' + String(vigilanteOwnerId ?? 'local'),
              'main',
              'principal',
            );
            const generation = thread.generation;
            const task = async () => {
              if (thread.generation !== generation) return { text: '' };
              thread.active = true;
              try {
                thread.agent.attachContext(
                  buildContextNote(
                    thread,
                    store,
                    memory,
                    snapshot,
                    workstreams,
                    skills,
                    sessions,
                    ownerProfile,
                  ),
                );
                const r = await thread.agent.run(text);
                return { text: r.text };
              } finally {
                thread.active = false;
                thread.gate.clearSession(thread.key);
              }
            };
            const next = thread.tail.then(task);
            thread.tail = next.then(
              () => undefined,
              () => undefined,
            );
            return next;
          },
          // Aprobaciones pendientes del broker (Telegram y panel ven la misma).
          approvals: () => approvals.list(),
          approve: async (id: string, decision: 'once' | 'session' | 'always' | 'deny') =>
            approvals.resolve(id, decision),
        },
        { port: Number(process.env.PA_WEB_PORT) },
      )
        .then((ui) => log.info('panel web listo', { url: ui.url }))
        .catch((err: unknown) => log.warn('panel web no arrancó', { err }));
    }
  }
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
  const learning = new LearnRecorder();
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

  /** thread.key -> live sync of installed factory tools (see factory/loader.ts). */
  const factorySyncs = new Map<string, () => Promise<void>>();

  const threadTools = (thread: Thread): AgentTool[] => {
    const scope = () => thread.key;
    const all: AgentTool[] = [
      ...fsTools,
      createFetchTool(),
      createWebTool(config),
      createDoneTool(),
      createAskTool(),
      createShellTool(config),
      // Each thread has its own gate and its own session key, so batch sub-actions
      // are policed by THIS conversation's approvals and an unwired gate never
      // silently blocks every batch. `sendPhoto` is what lets the model put a
      // capture in the user's chat instead of only in its own context: a
      // screenshot the user cannot see is a screenshot nobody sent.
      createComputerTool(
        config,
        screen,
        (call) => thread.gate.check(thread.key, { ...call, actor: 'asistenta' }),
        async (bytes, opts) => {
          const chatId = Number(thread.chatKey.split(':')[2]);
          const threadId = inboundFor(thread).threadId;
          await telegram.action(thread.chatKey.split(':')[2] ?? '', 'upload_photo');
          return telegram
            .sendPhotoBytes(chatId, bytes, threadId, opts)
            .then(() => true)
            .catch((err: unknown) => {
              log.warn('desktop screenshot send failed', { err });
              return false;
            });
        },
      ),
      createBrowserTool(browserFor(thread.key), scope, (png) =>
        telegram
          .sendPhotoBytes(Number(thread.chatKey.split(':')[2]), png, inboundFor(thread).threadId)
          .then(() => true),
      ),
      // Buying something, from searching to the payment screen, with one question at
      // the end and no way through it: `confirm` takes no selector and `select` refuses
      // any button that reads as a charge. The buyer's details come from the vault by
      // name and never reach the model's context - see commerce/profile.ts.
      //
      // The page is the thread's own browser, not a second one: a second Chromium would
      // mean a second login session and a second set of domain approvals for the same
      // site, and the flow would walk into a wall the user had to open twice.
      createCheckoutTool({
        page: createCheckoutPage(browserFor(thread.key), scope),
        requireApproval: (action, summary) => askCheckout(thread, action, summary),
        goal: () => recentRequestsLabel(thread),
        maxAmountCents: 30_000,
      }),
      // The durable memory plus the model's own procedural skills. The snapshot is
      // what makes the model stop asking who the user is; the skills are what make it
      // stop re-deriving a procedure it already worked out.
      createMemoryTool(memory, scope, snapshot, semanticRecall, sessions),
      createDocsTool(docMemory, scope),
      createDecisionTool({
        ledger: decisionLedger,
        workstreams,
        scopeOf: scope,
        inbound: () => {
          const live = threadInbound.get(thread.key);
          if (!live?.text) return undefined;
          return {
            messageId: live.messageId ?? '',
            userId: live.userId,
            text: live.text,
            receivedAt: live.receivedAt ?? '',
            authorised: live.authorised,
            scope: thread.key,
          };
        },
      }),
      createReminderTool({ store, scopeOf: scope, sync: () => routineRunner.sync() }),
      createAgendaTool((days) => personalAgenda(inboundFor(thread), days)),
      createGoalTool({
        goals: goalStore,
        scopeOf: scope,
        store,
        sync: () => routineRunner.sync(),
        workstreams,
        humanRepliedAfter: (scopeKey, sinceIso) =>
          sessions.hasHumanTurnSince(scopeKey, Date.parse(sinceIso)),
      }),
      createGestionTool({ gestor: gestorStore, scopeOf: scope, playbooks, routines: store }),
      createSkillsTool({ store: skills, semantic: semanticRecall }),
      // The tool factory: build -> subprocess test -> install with approval.
      // Installed tools are loaded right after agent creation (below), and an
      // install mid-chat lands on the next message via this onChange.
      createFactoryTool({
        onChange: () => {
          const sync = factorySyncs.get(thread.key);
          if (sync) void sync();
        },
      }),
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
        readLocal: () =>
          isOwnerDm(inboundFor(thread), vigilanteOwnerId)
            ? readLocalCalendar(join(paths.state, 'calendar', 'local.ics'))
            : Promise.resolve(undefined),
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
        // Biblioteca Secreta por la cuenta de Telegram del usuario (userbot de
        // `pa books setup`): fallback cuando las fuentes de dominio publico no
        // tienen el libro. Perezoso: sin setup, la tool lo dice y sigue.
        secret: new SecretLibrary(),
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

    // La tele LG se mira y se controla por SSAP (src/tv). Las acciones de solo
    // lectura NO entran en el mutex: mirar la tele no mueve la maquina y puede ir
    // en paralelo con una captura del escritorio. El estado de la ultima mirada
    // se guarda en la tabla kv de la Store, para que el agente sepa que habia en
    // pantalla sin volver a despertar la tele.
    all.push(createTvTool(tvToolDeps(store)));
    // El iPhone (esp32-iphone-agent): pantalla por AirPlay y toques por ESP32.
    all.push(createIphoneTool(iphoneToolDeps()));
    if (mcpTools.length) all.push(...mcpTools);

    // Only the tools that move the machine take the mutex. Wrapping read-only tools
    // would throw away the parallelism that makes multiple conversations worth having.
    const exclusive = new Set(['computer', 'shell', 'browser', 'checkout', 'write', 'media']);
    const raw = toolsForMode(all, desktop);
    return raw.map((tool): AgentTool => {
      if (!exclusive.has(tool.name)) return tool;
      const inner = tool.execute.bind(tool);
      return {
        ...tool,
        execute: (id, params, signal, onUpdate) =>
          // El signal de pi viaja al mutex: /stop cancela también la cola.
          machine.run(() => inner(id, params, signal, onUpdate), signal),
      };
    });
  };

  /**
   * One gate per conversation, because approval scope is per conversation: allowing
   * a click in one thread must not let the next thread click without asking.
   *
   * `always` is the deliberate exception, and it is the reason this function passes
   * `approvalsDb`: a standing grant is written to disk keyed by tool alone, so every
   * conversation, and every future run of the daemon, reads it back. A per-thread
   * grant would be indistinguishable from no grant at all - the next message opens a
   * new thread and asks again - which is the bug that made the "Siempre" button a lie.
   *
   * The holder indirection exists because the gate is built before the agent it
   * protects, and the approver only fires inside a tool call, which cannot happen
   * until the agent exists.
   */
  const gateFor = (
    threadKey: string,
    chatId: string,
    holder: { agent: PersonalAgent | null },
  ): Gate =>
    createDaemonGate({
      threadKey,
      dbPath: approvalsDb,
      // Full control is opt-in via the vault, never a command-line flag, so it cannot
      // be switched on by a stray script or a leftover shell history entry.
      fullControl,
      onAwaiting: (waiting) => {
        holder.agent?.setAwaitingApproval(waiting);
      },
      ask: async (key, tool, reason, question) => {
        log.info('approval requested', { thread: key, tool, reason });
        const choice = await telegram.offerApproval(
          randomUUID(),
          chatId,
          question ?? `¿Permito ${tool}?\n${reason}`,
          {
            askScope: true,
          },
        );
        return choice;
      },
    });

  /**
   * The human confirmation a purchase stops for.
   *
   * Two layers ask about the charge on purpose and neither is the other: the gate asks
   * because money always asks, and the tool asks because it is the only layer that
   * knows what is being bought and for how much. A gate that can be misconfigured is
   * not a reason to leave the charge to chance.
   *
   * The consequence is that the same purchase would put two identical questions in the
   * chat, and a prompt you answer twice by reflex is a prompt you stop reading. So the
   * answer is remembered for the turn, keyed by thread and by the exact question: the
   * second layer reuses the first answer rather than asking again. Keyed by question and
   * not by tool, so two different purchases in one turn still ask twice - which is the
   * case where a second question is worth the interruption.
   */
  const purchaseAnswers = new Map<string, boolean>();
  /** Telegram question with no scope buttons: "always pay" is not a thing. */
  const askOncePerTurn = async (thread: Thread, summary: string): Promise<boolean> => {
    const chatId = thread.chatKey.split(':')[2] ?? '';
    thread.agent.setAwaitingApproval(true);
    try {
      const choice = await telegram.offerApproval(randomUUID(), chatId, summary);
      return choice.approved;
    } finally {
      thread.agent.setAwaitingApproval(false);
    }
  };
  const askCheckout = async (thread: Thread, action: string, summary: string): Promise<boolean> => {
    const key = `${thread.key}:${action}:${summary}`;
    const remembered = purchaseAnswers.get(key);
    if (remembered !== undefined) return remembered;
    log.info('approval requested', { thread: thread.key, tool: action });
    const approved = await askOncePerTurn(thread, summary);
    purchaseAnswers.set(key, approved);
    return approved;
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
    // The gestor's effect guard rides this gate: while a gestion is active in
    // the thread, a call whose effect exceeds the class Nico approved for the
    // current step asks him again, past every memo, scope and window. It reads
    // the store live, so `paso` advances apply at once, and a thread rebuilt
    // after a restart re-installs the guard right here.
    gate.setForcedAsk(key, (call) =>
      effectOverrideReason(gestorStore.activeForScope(key), gate.classifyEffect(call)),
    );
    thread.agent = await PersonalAgent.create(config, threadTools(thread), gate, 'telegram-user', {
      sessionId: key,
      deferTools: true,
      // P6b: la extraccion pre-compactacion escribe en la memoria durable del
      // hilo (scope = thread.key, como el resto de herramientas de memoria).
      // Dedupe normalizado contra lo ya recordado; el store rechaza el resto
      // (secretos, lineas largas) y eso NO frena la compactacion.
      factMemory: {
        // Solo hechos ACTIVOS: uno sustituido (supersededBy) no esta vigente y
        // no puede bloquear re-registrar la preferencia anterior (A->B->A).
        existing: () =>
          memory
            .all(key)
            .filter((e) => e.supersededBy === null)
            .map((e) => e.text),
        write: (facts) => {
          let written = 0;
          const active = memory
            .all(key)
            .filter((e) => e.supersededBy === null)
            .map((e) => e.text);
          for (const fact of dedupeNewFacts(active, facts)) {
            try {
              memory.remember(key, fact, { tags: ['compaction'] });
              written++;
            } catch (err) {
              log.warn('compaction fact refused by memory store', { err: String(err) });
            }
          }
          return written;
        },
      },
    });
    const syncFactory = createFactorySync(
      (t) => thread.agent.registerFactoryTool(t),
      (n) => thread.agent.unregisterFactoryTool(n),
    );
    factorySyncs.set(key, syncFactory);
    await syncFactory();
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
      // Durable fallback: a goal notification's sent id lives in SQLite, so a
      // reply to a pending decision finds its owning thread even after a
      // daemon restart emptied messageThread.
      const goalScope = goalNotifier.scopeBySentId(chatKey_, inbound.replyToMessageId);
      if (goalScope) {
        const { chatKey: goalChatKey_, thread: goalThread_ } = splitGoalScope(goalScope);
        if (goalChatKey_ === chatKey_) {
          messageThread.set(`${chatKey_}:${inbound.replyToMessageId}`, goalScope);
          return getOrCreateThread(
            goalChatKey_,
            goalThread_,
            goalThread_ === 'main' ? 'principal' : goalThread_,
          );
        }
      }
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
        audio = {
          mimeType: spoken.mimeType,
          data: spoken.data.toString('base64'),
          durationSeconds: spoken.durationSeconds,
        };
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
      // El vigilante se para en el PRIMER statement: desde aquí no salen avisos
      // nuevos durante todo el cierre. Su drain (acotado por el timeout de la
      // agenda) corre en paralelo con el resto del apagado y se espera justo
      // antes de cerrar las bases de datos.
      const vigilanteDrain = vigilante.stop();
      const idleDrain = mailIdle?.stop();
      const attentionDrain = attention.stop();
      const channelDrain = registry.stopAll(true);
      // Observe early rejection while aborting turns; propagate it after drains.
      void channelDrain.catch(() => {});
      downloadsCtl.stop();
      // Stop acting first: a click mid-flight must not survive the shutdown.
      for (const thread of threads.values()) thread.agent.abort('external');
      telegram.cancelApprovals();
      const pending = [...threads.values()].map((t) => t.tail.catch(() => {}));
      await drainThreadTails(pending);
      clearInterval(goalDeliveryTimer);
      routineRunner.stop();
      // Release the microphone before anything else slow: an ffmpeg that is still
      // holding the capture device would keep the next app (or the next start) from
      // opening it.
      conversationOn = false;
      endSession('apagado');
      await stopWake();
      // El listener del boton se para antes que los navegadores: sigue siendo
      // una superficie de red abierta, y el corte no deberia dejarla escuchando
      // mientras el resto de la maquinaria se desmonta.
      await stopTvButton(true);
      await stopAlerts();
      // Every Chromium, or the next start refuses to claim the profile dir.
      await Promise.all([...browsers.values()].map((b) => b.closeAll(true)));
      await screen.dispose();
      await vigilanteDrain;
      await attentionDrain;
      await idleDrain;
      await channelDrain;
      store.close();
      memoryDb.close();
      goalsDb.close();
      docMemory.close();
      log.info('daemon stopped', { threads: threads.size });
    },
  });

  control?.attach(lifecycle);
  const goalStore = new GoalStore({ db: goalsDb });
  const gestorStore = new GestorStore({ db: goalsDb });
  const goalNotifier = new GoalNotifier({
    db: goalsDb,
    resolveGoal: (id) => goalStore.read(id),
    // A goal's messages go to the chat that owns the goal, and nowhere else.
    send: async (goal, text) => {
      // To the chat AND thread that own the goal: a forum topic gets threadId,
      // a message-grown conversation gets the note as a reply to its first
      // message, and the sent id is mapped so Nico's reply lands back in that
      // same thread instead of floating into #main.
      const target = goalNotifyTarget(goal.scope);
      if (!target) return null;
      try {
        const sentId = await telegram.send({
          channel: 'telegram',
          account: telegram.account,
          chatId: target.chatId,
          text,
          threadId: target.threadId,
          replyToMessageId: target.replyToMessageId,
        });
        if (!sentId) return null;
        // The sent id also lands in goal_notifications (sent_id): reply
        // routing survives a daemon restart emptying messageThread.
        messageThread.set(`${target.chatKey}:${sentId}`, goal.scope);
        return sentId;
      } catch (err) {
        log.warn('goal notify failed', { goal: goal.id, err });
        return null;
      }
    },
  });
  // The goal delivery engine: pending notifications (a decision Nico never
  // saw, a closing note) retry on their own clock, independent of any goal's
  // cron, of pause/resume and of the daily budget. It only delivers; it never
  // runs work. Rows live in SQLite, so retries survive restarts up to 24h.
  const goalDeliveryTimer = setInterval(() => {
    void goalNotifier.flushAll().catch((err: unknown) => {
      log.warn('goal delivery flush failed', { err });
    });
  }, NOTIFY_FLUSH_INTERVAL_MS);
  goalDeliveryTimer.unref();
  void goalNotifier.flushAll().catch(() => {}); // a reboot delivers at once
  const goalRunner = new GoalRunner({
    goals: goalStore,
    workstreams,
    notifier: goalNotifier,
    store,
    sync: () => routineRunner.sync(),
    onDone: (goal) => {
      if (!goal.workstreamId) return;
      safeRemember(() => workstreams.update(goal.workstreamId as string, { status: 'done' }));
    },
    execute: async (goal, prompt): Promise<GoalTickResult> => {
      // The tick rides the owning thread's tail, so it never collides with a
      // live conversation, and it runs through the thread's agent, so the gate
      // is exactly the one a chat message would face. What it does NOT do is
      // talk: no typing indicator, no progress notes, no auto-reply - a goal
      // speaks through the notifier alone (novedad o decisión).
      // The OWNING thread, not #main: the scope is a full thread key and the
      // tick must run where the goal was proposed, with that thread's agent,
      // context and gate - or objetivo:avance/reanudar would reject the tick's
      // own goal as belonging to another chat.
      const { chatKey: goalChatKey, thread: goalThreadName } = splitGoalScope(goal.scope);
      const thread = await getOrCreateThread(
        goalChatKey,
        goalThreadName,
        goalThreadName === 'main' ? 'principal' : goalThreadName,
      );
      const gen = thread.generation;
      const tick = async (): Promise<GoalTickResult> => {
        if (thread.generation !== gen) return { text: '', error: 'turno cancelado (/stop)' };
        thread.active = true;
        let sessionId = '';
        safeRemember(() => {
          // origin 'goal-tick': the machine's own session must never count as
          // Nico's answer to a pending decision (provenance, not titles).
          sessionId = sessions.begin(
            thread.key,
            `[objetivo] ${goal.title}`.slice(0, 80),
            'goal-tick',
          );
        });
        let result: AgentRunResult | null = null;
        try {
          thread.agent.attachContext(
            buildContextNote(
              thread,
              store,
              memory,
              snapshot,
              workstreams,
              skills,
              sessions,
              ownerProfile,
            ),
          );
          result = await thread.agent.run(prompt);
          safeRemember(() =>
            sessions.addTurn(sessionId, 'assistant', (result?.text ?? '').slice(0, 500)),
          );
          actions.record({
            actor: 'asistenta',
            action: 'objetivo-tick',
            target: thread.name,
            result: result?.error ? 'error' : 'ok',
            detail: `${result?.toolCalls ?? 0} tools`,
          });
          return { text: result?.text ?? '', error: result?.error ?? null };
        } catch (err) {
          return { text: '', error: err instanceof Error ? err.message : String(err) };
        } finally {
          thread.active = false;
          thread.gate.clearSession(thread.key);
          safeRemember(() => sessions.end(sessionId, (result?.text ?? '').slice(0, 200)));
        }
      };
      const next = thread.tail.then(tick);
      thread.tail = next.catch(() => {});
      return next;
    },
  });

  /**
   * Ejecuta la tarea de una rutina programada en el hilo que la creó.
   *
   * Antes, el tick solo publicaba la FICHA de la rutina ("⏰ Rutina X: <metadatos>"),
   * así que "/cron …" o "cada mañana a las 8 resumen del día" no hacían nada: el
   * usuario veía el horario en vez del trabajo. Ahora corre por el agente del hilo
   * (mismo contexto, mismo gate y mismo presupuesto) y devuelve su respuesta, que
   * es lo que se envía. Encadenado a thread.tail como un tick de objetivo: nunca
   * se solapa con una conversación viva.
   */
  const runRoutineTask = async (prompt: string, ctx: RoutineRunContext): Promise<string> => {
    const [chatPart, threadRaw] = ctx.scope.split('#');
    if (!chatPart) return '';
    const threadName = threadRaw || 'main';
    const thread = await getOrCreateThread(
      chatPart,
      threadName,
      threadName === 'main' ? 'principal' : threadName,
    );
    const generation = thread.generation;
    const task = async (): Promise<string> => {
      if (thread.generation !== generation) return '';
      thread.active = true;
      let sessionId = '';
      let text = '';
      safeRemember(() => {
        sessionId = sessions.begin(
          thread.key,
          `[rutina] ${ctx.routine.name}`.slice(0, 80),
          'goal-tick',
        );
      });
      try {
        thread.agent.attachContext(
          buildContextNote(
            thread,
            store,
            memory,
            snapshot,
            workstreams,
            skills,
            sessions,
            ownerProfile,
          ),
        );
        const result = await thread.agent.run(prompt);
        text = result.text ?? '';
        if (result.error)
          log.warn('routine run error', { routine: ctx.routine.name, error: result.error });
        safeRemember(() => sessions.addTurn(sessionId, 'assistant', text.slice(0, 500)));
      } finally {
        thread.active = false;
        thread.gate.clearSession(thread.key);
        safeRemember(() => sessions.end(sessionId, text.slice(0, 200)));
      }
      return text;
    };
    const next = thread.tail.then(task);
    thread.tail = next.catch(() => {});
    return next;
  };

  const runRoutineFire = async (_prompt: string, ctx: RoutineRunContext) => {
    // A goal tick EXECUTES; it never delivers its prompt as a message.
    if (isGoalRoutine(ctx.routine)) {
      await goalRunner.tickByRoutineName(ctx.routine.name);
      return;
    }
    // A scheduled routine answers into the chat it was learned in. It reuses the
    // thread of that scope when one exists, so the conversation that created the
    // routine also receives its output.
    const [chatPart] = ctx.scope.split('#');
    const chatId = chatPart?.split(':')[2] ?? '';
    if (!chatId) return;
    // A one-time reminder deleted after this job was registered (delivered late at
    // startup, cancelled) must not send again from a stale callback.
    if (isOneShotReminder(ctx.routine) && !oneShotStillPending(store, ctx.routine)) return;
    log.info('routine fired', { routine: ctx.routine.name, chatId });
    const reminder = isReminder(ctx.routine);
    // Un recordatorio solo avisa; una rutina TRABAJA. La tarea real se saca del
    // prompt de la rutina (o de su procedimiento guardado) y se ejecuta aquí,
    // como haría /routine a mano. `prompt` (los metadatos que pasa el runner) no
    // se usa para trabajar.
    const task = reminder
      ? ''
      : ctx.routine.kind === 'schedule' && ctx.routine.prompt
        ? ctx.routine.prompt
        : procedurePrompt(ctx.routine);
    let body = '';
    if (!reminder) {
      try {
        body = await runRoutineTask(task, ctx);
      } catch (err) {
        log.warn('routine execution failed', { routine: ctx.routine.name, err });
      }
      if (!body.trim()) body = 'No devolvió respuesta.';
    }
    const sent = await telegram
      .send({
        channel: 'telegram',
        account: telegram.account,
        chatId,
        text: reminder
          ? `⏰ Recordatorio: ${reminderText(ctx.routine)}`
          : `⏰ Rutina "${ctx.routine.name}":\n\n${body}`,
      })
      .then(() => true)
      .catch((err: unknown) => {
        log.warn('routine send failed', { err });
        return false;
      });
    // A one-time reminder is a cron pinned to a date: it would fire again next year.
    // Deleted only once it was delivered; if Telegram failed it is retried in 5 minutes
    // instead of vanishing.
    if (isOneShotReminder(ctx.routine)) {
      const outcome = settleOneShot(store, ctx.routine, sent);
      if (outcome === 'dropped') {
        log.warn('one-time reminder dropped after an hour of failed delivery', {
          routine: ctx.routine.name,
        });
        recordDroppedReminder(join(paths.state, 'dropped-reminders.jsonl'), ctx.routine.name);
      }
      routineRunner.sync();
    }
  };

  const routineRunner = new RoutineRunner({ store, run: runRoutineFire });
  // Overdue one-time reminders are delivered and deleted BEFORE the scheduler starts,
  // so a job due this minute cannot also fire fresh. At least once, never "exactly
  // once": see deliverMissedReminders.
  void deliverMissedReminders({
    store,
    send: async (scope, text) => {
      const chatId = scope.split('#')[0]?.split(':')[2] ?? '';
      if (!chatId) return false;
      // A hung send must not keep the scheduler from starting. A timeout counts as
      // failed, but the message may still arrive: delivery is at least once.
      const timeout = new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 20_000);
        t.unref?.();
      });
      const sent = telegram
        .send({ channel: 'telegram', account: telegram.account, chatId, text })
        .then(() => true)
        .catch((err: unknown) => {
          log.warn('missed reminder send failed', { err });
          return false;
        });
      return Promise.race([sent, timeout]);
    },
  })
    .catch((err: unknown) => {
      log.warn('missed reminder catch-up failed', { err });
      return null;
    })
    .then((r) => {
      if (r && (r.delivered || r.failed || r.invalid)) log.info('missed reminders', r);
    })
    .finally(() => routineRunner.start());

  // Disparadores por evento (token-cero): un archivo nuevo, un aviso de precio
  // o un mensaje disparan rutinas ya guardadas. El reparto es el MISMO de las
  // rutinas cron (runRoutineFire), así que no cuesta tokens ni duplica lógica.
  const triggerEngine = new TriggerEngine({
    store,
    run: (prompt, ctx) => runRoutineFire(prompt, { scope: ctx.scope, routine: ctx.routine }),
  });

  // ---- vigilante (ojo de águila) -------------------------------------------
  // Barrido proactivo: cada 30 min mira la agenda unificada (calendario + correo
  // + pendientes) y avisa por Telegram SOLO de lo nuevo, una vez por hallazgo
  // (el módulo guarda lo ya notificado en sqlite). Primer barrido a los 5 min:
  // al arrancar, las fuentes aún se están calentando.
  // Owner de los avisos: allowlist unitaria (asistente personal, ese usuario es
  // el dueño) o config explícita `vigilante:ownerUserId` en vault. La allowlist
  // autoriza USO del bot, NO propiedad de la agenda; sin owner verificado el
  // vigilante no envía nada (fail-closed).
  const vigilanteOwnerConfigured = Number((await vaultGet('vigilante:ownerUserId'))?.trim());
  const vigilanteOwnerId = resolveOwnerUserId(
    allowed,
    Number.isSafeInteger(vigilanteOwnerConfigured) && vigilanteOwnerConfigured > 0
      ? vigilanteOwnerConfigured
      : null,
  );
  panelGoals.initialize(goalStore, vigilanteOwnerId);
  // Perfil v2 por propietario: fuente del bloque <perfil> del prompt. Si está
  // vacío, buildContextNote cae al PERFIL.md legado (compatibilidad).
  const ownerProfile = new OwnerProfile(
    join(paths.state, 'profile', `${vigilanteOwnerId ?? 'local'}.json`),
  );

  const attention = new AttentionQueue({
    db: memoryDb,
    now: Date.now,
    timeZone: localTimeZone(),
    enabled: () =>
      getOjoEnabled(memoryDb) &&
      attentionFreeConfig(config) &&
      resolveOwnerDmChatId(
        [...threads.values()].map((t) => t.chatKey),
        vigilanteOwnerId,
      ) !== null,
    judge: createAttentionJudge(config),
    pace: () => currentLimits(memoryDb),
    send: async (text) => {
      const chatId = resolveOwnerDmChatId(
        [...threads.values()].map((t) => t.chatKey),
        vigilanteOwnerId,
      );
      if (!chatId) return false;
      await telegram.send({ channel: 'telegram', account: telegram.account, chatId, text });
      return true;
    },
  });
  // IDLE requires existing mail credentials and a verified owner DM. No new account or scope.
  const mailIdle = attentionFreeConfig(config)
    ? new MailIdleTransport({
        account: loadReadMailAccount,
        load: (scope) => {
          try {
            const raw = store.kvGet(`attention:imap:${scope}`);
            return raw ? (JSON.parse(raw) as IdleCursor) : null;
          } catch {
            return null;
          }
        },
        save: (scope, cursor) => store.kvSet(`attention:imap:${scope}`, JSON.stringify(cursor)),
        deliver: async (messages, scope) => {
          if (!getOjoEnabled(memoryDb)) throw new Error('Attention disabled');
          const deliveries = messages.map((m) => ({
            source: 'mail' as const,
            id: `${scope}:${m.id}`,
            text: `${m.subject}\n${m.text}`,
            at: m.at,
          }));
          await attention.offer(deliveries);
          if (!deliveries.every((event) => attention.accepted(event))) {
            throw new Error('Attention queue did not accept delivery');
          }
        },
        status: (state) => log.info('attention IMAP', { state }),
      })
    : null;
  mailIdle?.start();
  // Descargas: nace apagado (/ojo descargas on). Un vigilante de carpeta por encendido.
  const downloadsCtl = createDownloadsController({
    db: memoryDb,
    getOverride: async () => (await vaultGet('ojo:downloadsDir'))?.trim() || undefined,
    // Disparador 'archivo': solo entra una descarga de verdad nueva (dedupe en
    // recordDownload). Evento global (scope ''): dispara en cualquier chat.
    onNew: (filename) => {
      void triggerEngine.emit({ type: 'archivo', scope: '', text: filename }).catch((err) => {
        log.warn('trigger archivo falló', { err: String(err) });
      });
    },
  });

  if (getDownloadsEnabled(memoryDb)) {
    const st = await downloadsCtl.apply().catch(() => null);
    if (!st?.running)
      log.warn('descargas: encendido pero sin vigilar', { reason: st?.reason ?? 'error' });
  }
  // Pantalla: nace apagada (/ojo pantalla on). Solo Windows con escritorio interactivo. La
  // captura va a un temporal propio que se borra siempre; no se guarda ni imagen ni texto bruto.
  let lastScreenScan: ScanOutcome | null = null;
  const screenScan = async (): Promise<ScanOutcome> => {
    if (process.platform !== 'win32') {
      lastScreenScan = { ok: false, reason: 'solo funciona en Windows' };
      return lastScreenScan;
    }
    lastScreenScan = await scanScreenOnce({
      db: memoryDb,
      interactive: hasInteractiveDesktop,
      windows: async () =>
        (await listWindows()).map((w) => ({ title: w.title, process: w.process })),
      capture: async () => {
        if (!(await ocrAvailable())) throw new Error('sin OCR de Windows');
        const shooter = new WindowsScreen();
        const dir = mkdtempSync(join(tmpdir(), 'ojo-pantalla-'));
        const cleanup = (): void => {
          rmSync(dir, { recursive: true, force: true });
          void shooter.dispose();
        };
        try {
          const shot = await shooter.screenshot();
          const file = join(dir, 'p.jpg');
          writeFileSync(file, shot.image);
          return { path: file, cleanup };
        } catch (err) {
          cleanup();
          throw err;
        }
      },
      ocr: async (path) => (await ocrImage(path)).lines.map((l) => l.text),
    });
    return lastScreenScan;
  };
  const vigilante = startVigilanteLoop(
    {
      db: memoryDb,
      quiet: DEFAULT_QUIET_HOURS,
      screenScan,
      downloadsHealth: () => downloadsCtl.apply(),
      downloadsSuppressed: () => downloadsCtl.suppressed(),
      agenda: async () => {
        let calendarReason: string | undefined;
        const agenda = await buildAgenda({
          calendar: async () => {
            const calendarSnapshot = await loadCalendar({
              readLocal: () => readLocalCalendar(join(paths.state, 'calendar', 'local.ics')),
              getUrl: () => vaultGet('calendar:icsUrl'),
              fetchText: async (url) => {
                // Timeout duro: un servidor de calendario colgado no puede eternizar
                // el barrido ni el drain del apagado.
                const res = await fetch(url, {
                  redirect: 'follow',
                  signal: AbortSignal.timeout(15_000),
                });
                if (!res.ok) throw new Error(`el calendario ha respondido ${res.status}`);
                return res.text();
              },
            });
            calendarReason = calendarSnapshot.reason;
            const events = calendarSnapshot.events;
            void attention.offer(
              events
                .filter(
                  (e) => !e.allDay && e.start > Date.now() && e.start - Date.now() < 2 * 3_600_000,
                )
                .map((e) => ({
                  source: 'meeting' as const,
                  id: `${e.title}:${e.start}`,
                  text: `${e.title} - ${new Date(e.start).toISOString()}`,
                  at: Date.now(),
                })),
            );
            return events;
          },
          mail: async () => {
            const account = await loadMailAccount();
            if (!account) return [];
            // Tres días hacia atrás: el extractor solo propone fechas futuras, y un
            // buzón entero por barrido es ruido y tiempo de IMAP.
            // Deadline duro: un IMAP colgado no se apila entre barridos.
            const messages = await searchMail(
              account,
              { since: Date.now() - 3 * 86_400_000 },
              30,
              20_000,
            );
            return messages;
          },
          followups: () => followups.list(undefined, 200),
          // 35 días: las caducidades avisan a 30 días; lo demás sigue en 7 (collectFindings).
          days: 35,
        });
        if (calendarReason) agenda.notes.push(calendarReason);
        return agenda;
      },
      // Cargos raros: la primera vez siembra el historial (hasta 200 correos de 120 días);
      // después solo los últimos días. Mismo tope duro que el correo de la agenda.
      charges: async (sinceMs) => {
        const account = await loadMailAccount();
        if (!account) return [];
        const seeding = Date.now() - sinceMs > 10 * 86_400_000;
        return searchMail(account, { since: sinceMs }, seeding ? 200 : 30, 30_000);
      },
      send: (text) => {
        // Destinatario fijo: el DM del owner verificado arriba. Un grupo — aunque
        // hable un usuario permitido — NO es destino: la agenda es privada. Sin DM
        // del owner, fail-closed: no se envía y se reintenta en el próximo barrido.
        const chatId = resolveOwnerDmChatId(
          [...threads.values()].map((t) => t.chatKey),
          vigilanteOwnerId,
        );
        if (!chatId) {
          log.warn('vigilante: sin DM de owner verificado; el hallazgo queda pendiente', {});
          return Promise.resolve(false);
        }
        return telegram
          .send({ channel: 'telegram', account: telegram.account, chatId, text })
          .then(() => true)
          .catch((err: unknown) => {
            log.warn('vigilante: send failed', { err });
            return false;
          });
      },
    },
    localTimeZone(),
    30 * 60 * 1000,
    5 * 60 * 1000,
  );

  const mailReplyCards = new Map<string, string>();
  // Explicit authenticated owner command, intentionally not exposed as an agent tool.
  const cmdCorreo = async (inbound: Inbound, args: string): Promise<void> => {
    if (
      String(inbound.userId) !== String(vigilanteOwnerId) ||
      inbound.chatId !== String(vigilanteOwnerId)
    ) {
      await say(inbound, 'Correo solo disponible en el DM del dueño.', { quote: true });
      return;
    }
    if (args.trim() === 'estado') {
      try {
        await say(inbound, (await mailStatus()).lines.join('\n'), { quote: true });
      } catch {
        await say(inbound, 'No se pudo leer el estado del correo.', { quote: true });
      }
      return;
    }
    if (args.trim() === 'lista') {
      try {
        const account = await loadReadMailAccount();
        if (!account) throw new Error('No account');
        const rows = await listReplyInbox(account);
        for (const row of rows) {
          const clean = (text: string) => text.replace(/\s+/g, ' ').slice(0, 180);
          const card = await say(
            inbound,
            `${row.ref}\nDe (no verificado): ${clean(row.from)}\nAsunto: ${clean(row.subject)}\nResponde a ESTE mensaje con "responde a ese" y, en nueva línea, tu texto exacto.`,
            { quote: true },
          );
          if (card) mailReplyCards.set(card, row.ref);
          while (mailReplyCards.size > 100) {
            const key = mailReplyCards.keys().next().value;
            if (key) mailReplyCards.delete(key);
          }
        }
        if (!rows.length) await say(inbound, 'INBOX no devuelve correos.', { quote: true });
      } catch {
        await say(inbound, 'No se pudo leer la lista de correo.', { quote: true });
      }
      return;
    }
    const chosen = resolveReplyCard(args, inbound.replyToMessageId, mailReplyCards);
    const input = chosen ? `responder ${chosen}\n${args.slice(args.indexOf('\n') + 1)}` : args;
    const match = /^responder\s+([1-9]\d*:[1-9]\d*)\s*\n([\s\S]+)$/.exec(input);
    if (!match) {
      await say(
        inbound,
        'Uso: /correo estado, /correo lista o /correo responder UIDVALIDITY:UID seguido de una nueva línea con el texto exacto (máximo 2500 caracteres).',
        { quote: true },
      );
      return;
    }
    try {
      const result = await replyOnOwnerRequest(match[1] ?? '', match[2] ?? '', {
        readAccount: loadReadMailAccount,
        sendAccount: loadSendMailAccount,
        review: async (preview) =>
          (await telegram.offerApproval(randomUUID(), inbound.chatId, preview)).approved,
      });
      await say(
        inbound,
        result.ok
          ? 'Correo enviado (aceptado por SMTP, no confirma entrega).'
          : (result.error ?? 'No enviado.'),
        { quote: true },
      );
    } catch {
      await say(
        inbound,
        'No se pudo preparar o enviar el correo. No se reintenta automáticamente; revisa Enviados antes de repetir si hubo un fallo de red.',
        { quote: true },
      );
    }
  };

  /** `/ojo [on|off]`: interruptor general del ojo de águila y su estado. */
  let ocrBusy = false;
  const cmdOcr = async (inbound: Inbound, args: string): Promise<void> => {
    const mode = parseOcrMode(args);
    if (!mode) {
      await say(
        inbound,
        'Uso: manda un PDF o una foto con el pie «/ocr» (PDF con texto), «/ocr md» (Markdown) o «/ocr todo» (los dos).',
        { quote: true },
      );
      return;
    }
    if (!isOwnerDm(inbound, vigilanteOwnerId)) {
      await say(inbound, 'Este comando solo funciona en el chat privado del dueño.', {
        quote: true,
      });
      return;
    }
    const fileId = inbound.documentFileId ?? inbound.photoFileId;
    if (!fileId) {
      await say(
        inbound,
        'Mándame un PDF o una foto y escribe «/ocr» en el pie del archivo (también «/ocr md» o «/ocr todo»). Te devuelvo el PDF con el texto seleccionable y buscable.',
        { quote: true },
      );
      return;
    }
    if (ocrBusy) {
      await say(
        inbound,
        'Estoy con otro documento. Este no lo he procesado: mándalo de nuevo cuando termine.',
        { quote: true },
      );
      return;
    }
    ocrBusy = true;
    try {
      const bytes = await telegram.downloadFile(fileId).catch(() => null);
      if (!bytes) {
        await say(
          inbound,
          'No he podido bajar el archivo (Telegram solo me deja hasta 20 MB). Si es más grande, pártelo.',
          { quote: true },
        );
        return;
      }
      await say(
        inbound,
        'Recibido, lo estoy procesando. Si tiene muchas páginas tarda unos minutos.',
        { quote: true },
      );
      const result = await runOcrJob(
        Buffer.from(bytes),
        { name: inbound.documentName },
        mode,
        windowsDeps,
      );
      for (const f of result.files) {
        await telegram.sendDocumentBytes(
          Number(inbound.chatId),
          f.bytes,
          f.filename,
          '',
          inbound.threadId,
        );
      }
      await say(inbound, result.message, { quote: true });
    } catch (err) {
      log.warn('ocr command failed', { err: String(err).slice(0, 200) });
      await say(inbound, 'No he podido terminar el OCR. Tu original no se ha tocado.', {
        quote: true,
      }).catch(() => {});
    } finally {
      ocrBusy = false;
    }
  };

  const cmdOjo = async (inbound: Inbound, args: string): Promise<void> => {
    const arg = args.trim().toLowerCase();
    const dm = /^descargas(?:\s+(on|off|estado))?$/.exec(arg);
    if (dm) {
      if (!isOwnerDm(inbound, vigilanteOwnerId)) {
        await say(inbound, 'Este comando solo funciona en el chat privado del dueño.', {
          quote: true,
        });
        return;
      }
      const want = dm[1];
      if (want === 'on' || want === 'off') setDownloadsEnabled(memoryDb, want === 'on');
      const st = await downloadsCtl.apply();
      const on = getDownloadsEnabled(memoryDb);
      await say(
        inbound,
        on
          ? st.running
            ? 'Descargas: encendido. Te aviso de los archivos nuevos que lleguen a tu carpeta de Descargas (solo el nombre y el tipo, no los abro) en el siguiente barrido; en horas de silencio esperan. /ojo descargas off lo apaga.'
            : `Descargas: encendido, pero ${st.reason ?? 'no he podido empezar a vigilar'}. Puedes fijar la carpeta en la bóveda con ojo:downloadsDir.`
          : 'Descargas: apagado (es lo normal; /ojo descargas on lo enciende).',
        { quote: true },
      );
      return;
    }
    const pm = /^pantalla(?:\s+(on|off|estado))?$/.exec(arg);
    if (pm) {
      if (!isOwnerDm(inbound, vigilanteOwnerId)) {
        await say(inbound, 'Este comando solo funciona en el chat privado del dueño.', {
          quote: true,
        });
        return;
      }
      const want = pm[1];
      if (want === 'on' || want === 'off') setScreenEnabled(memoryDb, want === 'on');
      await say(
        inbound,
        getScreenEnabled(memoryDb)
          ? `Pantalla: encendido. En cada barrido (cada 30 min, fuera de las horas de silencio) miro la pantalla un instante con el OCR de Windows y te aviso de plazos, pagos o importes que vea. No guardo la captura ni el texto bruto (solo aviso con lo que vi, ocultando IBAN, emails, números largos y claves; nombres propios no los reconoce, pueden salir); no miro si hay abierto un banco, un gestor de contraseñas, una ventana privada o algo de salud. Es una lectura que puede fallar. ${screenStatusText(lastScreenScan)} /ojo pantalla off lo apaga.`
          : 'Pantalla: apagado (es lo normal; /ojo pantalla on lo enciende).',
        { quote: true },
      );
      return;
    }
    if (arg === 'on' || arg === 'off') {
      setOjoEnabled(memoryDb, arg === 'on');
    } else if (arg && arg !== 'estado') {
      await say(
        inbound,
        'Uso: /ojo on, /ojo off, /ojo (estado), /ojo descargas on|off o /ojo pantalla on|off.',
        {
          quote: true,
        },
      );
      return;
    }
    const quiet = DEFAULT_QUIET_HOURS;
    const ownerView = isOwnerDm(inbound, vigilanteOwnerId);
    const dst = ownerView && getDownloadsEnabled(memoryDb) ? await downloadsCtl.apply() : null;
    const screenLine = !ownerView
      ? null
      : getScreenEnabled(memoryDb)
        ? `Pantalla: encendido. ${screenStatusText(lastScreenScan)}`
        : 'Pantalla: apagado (/ojo pantalla on lo enciende).';
    const downloadsLine = !ownerView
      ? null
      : !dst
        ? 'Descargas: apagado (/ojo descargas on lo enciende).'
        : dst.running
          ? 'Descargas: encendido y vigilando tu carpeta de Descargas.'
          : `Descargas: encendido pero SIN vigilar (${dst.reason ?? 'error'}).`;
    await say(
      inbound,
      [
        `Ojo de águila: ${getOjoEnabled(memoryDb) ? 'encendido' : 'apagado'}.`,
        downloadsLine,
        screenLine,
        'Cada 30 min miro calendario, correo y pendientes y te aviso de plazos, pagos, viajes y citas nuevos. Plazos, pagos y citas con hora llevan además un recordatorio a 24 h y otro a 2 h; los que no tienen hora, uno solo el día antes a las 9:00; los viajes, solo el aviso inicial. Lo que caduca o se renueva avisa a 30, 7 y 1 día (a las 9:00). También te aviso de citas con hora que se pisan y de cargos raros en el correo (más de 1,5 veces lo habitual o un remitente nuevo; es una lectura del correo, puede fallar). Las descargas nuevas y la lectura de pantalla solo si lo pides: /ojo descargas on, /ojo pantalla on.',
        `Cada aviso lleva [#n]: /ignora n lo descarta, y tras dos parecidos te propongo una regla (/ignorados). Silencio de ${quiet.startHour}:00 a ${quiet.endHour}:00; solo rompo el silencio por un pago o plazo con hora a menos de 2 h (las citas, viajes y conflictos esperan a que acabe).`,
      ]
        .filter((l): l is string => l !== null)
        .join('\n'),
      { quote: true },
    );
  };

  /** `/ignora <n>`: descarta el aviso [#n]; a los 2 descartes parecidos propone una regla. */
  const cmdIgnora = async (inbound: Inbound, args: string): Promise<void> => {
    if (!isOwnerDm(inbound, vigilanteOwnerId)) {
      await say(inbound, 'Este comando solo funciona en el chat privado del dueño.', {
        quote: true,
      });
      return;
    }
    const m = /^#?(\d{1,9})$/.exec(args.trim());
    if (!m) {
      await say(
        inbound,
        'Uso: /ignora <número del aviso>, el que sale entre corchetes [#n]. /ignorados lista las reglas.',
        { quote: true },
      );
      return;
    }
    const res = dismissNotice(memoryDb, Number(m[1]), Date.now());
    if (!res.ok) {
      await say(inbound, res.error, { quote: true });
      return;
    }
    if (res.already) {
      await say(inbound, `El aviso #${m[1]} ya estaba descartado.`, { quote: true });
      return;
    }
    const lines = [
      `Descartado «${res.title.slice(0, 80)}»: no te lo vuelvo a recordar. Excepción: un pago o plazo con hora a menos de 2 h te lo aviso una vez más.`,
    ];
    if (res.noClass) {
      lines.push('Su título no da un patrón fiable, así que no cuenta para proponer reglas.');
    }
    if (res.proposal) {
      const r = res.proposal;
      lines.push(
        '',
        `Has descartado ya 2 avisos parecidos (${r.kind} · ${r.src} · «${r.pattern}»). ¿Dejo de avisarte de esa clase? Dime /ignorados activar ${r.id}, o /ignorados borrar ${r.id} para olvidarla.`,
      );
    }
    const stepped = recordDismissal(memoryDb, Date.now());
    if (stepped) {
      lines.push(
        '',
        `Has descartado 3 avisos en dos días, así que bajo el ritmo a «${stepped}». ${paceText(stepped)}`,
      );
    }
    await say(inbound, lines.join('\n'), { quote: true });
  };

  /** `/avisos [menos|minimo|normal]`: ritmo de avisos; solo puede ser más estricto que el límite base. */
  const cmdAvisos = async (inbound: Inbound, args: string): Promise<void> => {
    if (!isOwnerDm(inbound, vigilanteOwnerId)) {
      await say(inbound, 'Este comando solo funciona en el chat privado del dueño.', {
        quote: true,
      });
      return;
    }
    const want = parsePace(args);
    if (want === null) {
      await say(inbound, 'Uso: /avisos (estado), /avisos menos, /avisos minimo o /avisos normal.', {
        quote: true,
      });
      return;
    }
    if (want !== 'estado') setPace(memoryDb, want);
    await say(inbound, paceText(getPace(memoryDb)), { quote: true });
  };

  /** `/ignorados [activar|borrar <id>]`: ver y gestionar las reglas de ignorar. */
  const cmdIgnorados = async (inbound: Inbound, args: string): Promise<void> => {
    if (!isOwnerDm(inbound, vigilanteOwnerId)) {
      await say(inbound, 'Este comando solo funciona en el chat privado del dueño.', {
        quote: true,
      });
      return;
    }
    const m = /^(activar|borrar)\s+R?(\d{1,9})$/i.exec(args.trim());
    if (args.trim() && !m) {
      await say(inbound, 'Uso: /ignorados, /ignorados activar <id> o /ignorados borrar <id>.', {
        quote: true,
      });
      return;
    }
    if (m) {
      const id = Number(m[2]);
      const out =
        (m[1] ?? '').toLowerCase() === 'activar'
          ? activateRule(memoryDb, id)
          : deleteRule(memoryDb, id);
      if (!out.ok) {
        await say(inbound, out.error ?? 'No se ha podido.', { quote: true });
        return;
      }
    }
    await say(inbound, formatRules(listRules(memoryDb)), { quote: true });
  };

  // ---- commands -----------------------------------------------------------

  /**
   * Take a picture of the desktop and put it in the chat.
   *
   * Separate from `cmdScreen` because the command answers and this one only sends: it
   * runs before the turn, on its own, and its failure must never take the turn down with
   * it. That is why every step is caught and the caller only ever sees a promise that
   * resolves regardless.
   */
  const sendScreenShot = async (
    inbound: Inbound,
    caption: string,
    threadKey?: string,
  ): Promise<boolean> => {
    if (!desktop) {
      // Headless: no desktop to photograph, but the page the task is working on counts.
      const service = threadKey ? browsers.get(threadKey) : undefined;
      if (!service || !threadKey) return false;
      try {
        const png = await capturePageIfOpen(service, threadKey);
        if (!png) return false;
        await telegram.action(inbound.chatId, 'upload_photo');
        const sent = await telegram.sendPhotoBytes(Number(inbound.chatId), png, inbound.threadId);
        if (!sent) return false;
        await say(inbound, 'Así está la página del navegador ahora mismo.', { quote: true });
        return true;
      } catch (err) {
        log.warn('browser page capture failed', { err });
        return false;
      }
    }
    try {
      await telegram.action(inbound.chatId, 'upload_photo');
      const shot = await screen.screenshot();
      const sent = await telegram.sendPhotoBytes(
        Number(inbound.chatId),
        shot.image,
        inbound.threadId,
        { width: shot.width, height: shot.height },
      );
      if (!sent) return false;
      await say(inbound, caption, { quote: true });
      log.info('screenshot sent on request', {
        chatId: inbound.chatId,
        width: shot.width,
        height: shot.height,
      });
      return true;
    } catch (err) {
      log.warn('screen capture failed', { err });
      await say(inbound, 'No he podido hacer la captura ahora mismo.', { quote: true }).catch(
        () => {},
      );
      return false;
    }
  };

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
      const ended = learning.end(inbound.chatId, thread.key, thread.agent);
      if (!ended.ok) {
        const text =
          ended.reason === 'none'
            ? 'No estaba grabando ninguna rutina. Empieza con /learn <nombre>.'
            : ended.reason === 'other-thread'
              ? `Estoy grabando "${ended.name}" en otra conversación. Cierra allí con /learn end, o empieza de nuevo aquí con /learn <nombre>.`
              : 'No puedo aislar con certeza lo que demostraste (la conversación se resumió o se reinició desde que empecé a grabar). Empieza de nuevo con /learn <nombre>.';
        await say(inbound, text, { quote: true });
        return;
      }
      const recorded = ended.name;
      await say(inbound, 'Resumiendo los pasos que acabas de hacer⬦', { quote: true });
      const transcript = summarizeTranscript(ended.segment);
      const result = await enqueue(thread, () =>
        thread.agent.run(
          [
            'Acabas de ayudar al usuario a hacer esta tarea paso a paso:',
            transcript,
            '',
            'Escribe en español los pasos reutilizables, en tercera persona e imperativo breve,',
            'uno por línea, sin numeración ni explicaciones. Empieza por el más general.',
            'Si un dato cambia de una ejecución a otra (destinatario, fichero, dominio, texto),',
            'escribe un parámetro {nombre} en vez del valor concreto: nombre con letras, números, _ o -;',
            '{fichero}, {correo} y {dominio} (o {url}) llevan validación de tipo, cualquier otro nombre es texto.',
            'No uses llaves para nada más. Tras cada paso que se pueda comprobar, añade " verifica: <qué comprobar>".',
            'Si algún paso requiere una contraseña o un pago, escribe [PIDE CONFIRMACIÓN].',
            'Si no se puede reutilizar, escribe una sola línea: NO REUTILIZABLE.',
            'No escribas nada más: ni título, ni comentarios, ni código fences.',
          ].join('\n'),
        ),
      );
      const steps = result.text.trim();
      if (!steps) {
        await say(inbound, 'No he podido resumir los pasos.', { quote: true });
        return;
      }
      // Steps with {placeholders} make it a macro: it is saved under the
      // macro/ namespace with its typed parameter contract, and the contract is
      // shown in the confirmation. Detection is only as good as what the
      // summariser emitted, so the user is told to re-record if it is wrong.
      const params = detectMacroParams(steps);
      const macro = params.length > 0;
      if (!macro && isMacroName(recorded)) {
        await say(
          inbound,
          'El prefijo macro/ es solo para macros con {parámetros}; esta grabación no tiene ninguno. Grábala con otro nombre.',
          { quote: true },
        );
        return;
      }
      const routine = store.saveRoutine({
        scope: thread.key,
        name: macro ? canonicalMacroName(recorded) : recorded,
        kind: 'procedure',
        params: macro ? params : null,
        steps,
      });
      await say(
        inbound,
        [
          macro
            ? `Macro "${routine.name}" guardada. La ejecutas con /routine ${routine.name} ${params
                .map((p) => `${p.name}=...`)
                .join(' ')}.`
            : `Rutina "${routine.name}" guardada. Replaying con /routine ${routine.name}.`,
          ...(macro
            ? [
                '',
                'Parámetros detectados (si falta alguno o sobra, vuelve a grabarla):',
                ...params.map((p) => `- ${p.name} (${p.type})`),
              ]
            : []),
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
    learning.start(inbound.chatId, name, thread.key, thread.agent);
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
    // A macro takes clave=valor arguments and validates ALL of them before
    // substituting anything: a bad call gets the full error list and runs
    // nothing. A plain routine takes no arguments at all.
    const tokens = args.trim().split(/\s+/).slice(1);
    let prompt: string;
    if (isMacroName(routine.name) && !routine.params?.length) {
      // The macro/ namespace never falls back to a plain replay: without a
      // valid contract the steps would reach the model with raw {placeholders}.
      await say(
        inbound,
        `La macro ${routine.name} no tiene un contrato de parámetros válido: no se ejecuta. Regrábala con /learn.`,
        { quote: true },
      );
      return;
    } else if (routine.params?.length) {
      const parsed = parseMacroArgs(tokens);
      if (!parsed.ok) {
        await say(
          inbound,
          `${parsed.error} Uso: /routine ${routine.name} ${routine.params
            .map((p) => `${p.name}=...`)
            .join(' ')}.`,
          { quote: true },
        );
        return;
      }
      const built = buildMacroPrompt(routine, parsed.args);
      if (!built.ok) {
        await say(inbound, built.error, { quote: true });
        return;
      }
      prompt = built.prompt;
    } else if (tokens.length) {
      await say(
        inbound,
        `"${routine.name}" no tiene parámetros: se repite tal cual con /routine ${routine.name}.`,
        { quote: true },
      );
      return;
    } else {
      prompt =
        routine.kind === 'schedule' && routine.prompt ? routine.prompt : procedurePrompt(routine);
    }
    store.markRoutineRun(routine.scope, routine.name);
    messageThread.set(`${chatKey(inbound)}:${inbound.messageId}`, thread.key);
    await enqueue(thread, () => runTurn(thread, inbound, prompt, {}));
  };

  const cmdRoutines = async (inbound: Inbound): Promise<void> => {
    const chatKey_ = chatKey(inbound);
    const list = store.listRoutines().filter((r) => inChatScope(r.scope, chatKey_));
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
   * /cron: gestión de las rutinas programadas del chat, viva y sin reinicio
   * (routineRunner.sync tras cada cambio). Limitación declarada (hallazgo del
   * item 14): las entradas PA_CRON del entorno se parsean y validan al boot
   * pero NUNCA se programan ni tienen chat destino; este comando opera sobre
   * las rutinas del store, que son las que de verdad disparan.
   */
  /**
   * /disparador: event triggers for stored routines, token-zero dispatch.
   * Same live rule as /cron: a saved trigger works without a daemon restart
   * (the engine reads the store on every event, no timers to rebuild).
   */
  const cmdTrigger = async (thread: Thread, inbound: Inbound, args: string): Promise<void> => {
    const chatKey_ = chatKey(inbound);
    const [subRaw, ...restParts] = args.trim().split(/\s+/).filter(Boolean);
    const sub = (subRaw ?? '').toLowerCase();
    const rest = restParts.join(' ');
    if (sub === 'del' || sub === 'borra' || sub === 'rm') {
      const n = Number(rest.trim());
      const scoped = store.listTriggers().filter((t) => inChatScope(t.scope, chatKey_));
      const victim = Number.isInteger(n) && n >= 1 ? scoped[n - 1] : undefined;
      if (!victim) {
        await say(inbound, 'Uso: /disparador del <número de /disparadores>.', { quote: true });
        return;
      }
      store.deleteTrigger(victim.id);
      await say(
        inbound,
        `Disparador ${n} borrado: [${victim.event}] "${victim.match}" ya no dispara ${victim.routine}.`,
        { quote: true },
      );
      return;
    }
    if (!rest.trim() && !sub) {
      await say(
        inbound,
        formatTriggerList(store.listTriggers().filter((t) => inChatScope(t.scope, chatKey_))),
        { quote: true },
      );
      return;
    }
    const parsed = parseTriggerAdd(args.trim());
    if (!parsed.ok) {
      await say(inbound, parsed.error, { quote: true });
      return;
    }
    const { event, match, routine: routineName, args: macroArgs } = parsed.value;
    const routine =
      store.getRoutine(thread.key, routineName) ??
      store.getRoutine(`${chatKey_}#main`, routineName);
    if (!routine) {
      await say(
        inbound,
        `No tengo ninguna rutina llamada "${routineName}". Grábala primero con /learn ${routineName}.`,
        { quote: true },
      );
      return;
    }
    if (!routine.enabled) {
      await say(
        inbound,
        `La rutina "${routineName}" está desactivada: reactívala antes de dispararla.`,
        { quote: true },
      );
      return;
    }
    // A macro is only triggerable when its fixed args satisfy the whole contract
    // TODAY: an event can never supply what is missing later.
    const probe = buildTriggerPrompt(routine, {
      id: '',
      scope: routine.scope,
      routine: routine.name,
      event,
      match,
      args: macroArgs,
      enabled: true,
      cooldownSeconds: 0,
      lastFiredAt: null,
      createdAt: '',
    });
    if (!probe.ok) {
      await say(
        inbound,
        `Esa rutina no se puede disparar por evento: ${probe.error}. ` +
          (isMacroName(routineName)
            ? `Pasa sus parámetros fijos: /disparador ${args.trim()} clave=valor.`
            : ''),
        { quote: true },
      );
      return;
    }
    const scope = routine.scope;
    const saved = store.saveTrigger({
      scope,
      routine: routine.name,
      event,
      match,
      args: macroArgs,
    });
    await say(
      inbound,
      `Disparador guardado: cuando [${event}] contenga "${match}", disparo "${routine.name}" ` +
        `(mínimo cada ${saved.cooldownSeconds}s). Lo ves con /disparadores.`,
      { quote: true },
    );
  };

  const cmdCron = async (thread: Thread, inbound: Inbound, args: string): Promise<void> => {
    // La lógica vive en runCronCommand (exportada) para que los canarios del
    // comando — colisiones, aislamiento por chat, sync en vivo — corran
    // contra un Store y un RoutineRunner reales sin levantar el daemon.
    await say(
      inbound,
      runCronCommand(
        { store, routineRunner, threadKey: thread.key, chatKey: chatKey(inbound) },
        args,
      ),
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
  const scheduledAgenda = (inbound: Inbound): string => {
    const chatKey_ = chatKey(inbound);
    const scheduled = store
      .listRoutines()
      .filter((r) => inChatScope(r.scope, chatKey_) && r.kind === 'schedule');
    if (!scheduled.length) {
      return 'No hay rutinas programadas. Puedes crearlas con /routine.';
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
    return [`Rutinas programadas: ${scheduled.length}`, ...lines].join('\n');
  };

  const personalAgenda = (inbound: Inbound, days = 7): Promise<string> =>
    readAgendaOverview(
      {
        authorised: () => inbound.authorised && isOwnerDm(inbound, vigilanteOwnerId),
        calendar: (window) =>
          loadCalendar({
            readLocal: () => readLocalCalendar(join(paths.state, 'calendar', 'local.ics')),
            getUrl: () => vaultGet('calendar:icsUrl'),
            fetchText: async (url) => {
              const response = await fetch(url, {
                redirect: 'follow',
                signal: AbortSignal.timeout(15_000),
              });
              if (!response.ok) throw new Error(`el calendario ha respondido ${response.status}`);
              return response.text();
            },
            days: window,
          }),
        followups: () => followups.list(undefined, 200),
        routines: () => scheduledAgenda(inbound),
        goals: () => goalStore.list().filter((goal) => inChatScope(goal.scope, chatKey(inbound))),
      },
      days,
    );
  const cmdAgenda = async (inbound: Inbound, args = ''): Promise<void> => {
    // Keep the established routine listing available without revealing private sources.
    const text =
      args.trim() === 'rutinas' || !isOwnerDm(inbound, vigilanteOwnerId)
        ? scheduledAgenda(inbound)
        : await personalAgenda(inbound);
    await say(inbound, text, { quote: true });
  };

  const cmdMemory = async (inbound: Inbound): Promise<void> => {
    // Resolución de inspección: NUNCA crea hilo y, a falta de intención
    // explícita (/topic, respuesta a un mensaje nuestro, hilo de Telegram),
    // lee main aunque esté ocupado. resolveThread aplicaría la heurística de
    // peticiones nuevas: con main ocupado crearía #m<messageId> y /memory
    // volvería a decir "No recuerdo nada" con la memoria llena (auditor #152).
    const chatKey_ = chatKey(inbound);
    const key = inspectionThreadKey({
      chatKey: chatKey_,
      activeTopic: activeTopic.get(chatKey_),
      replyThreadKey: inbound.replyToMessageId
        ? messageThread.get(`${chatKey_}:${inbound.replyToMessageId}`)
        : undefined,
      // Fallback durable, como resolveThread: tras un reinicio messageThread
      // está vacío y la notificación persistida de un objetivo sigue encontrando
      // su hilo. scopeBySentId ya filtra por chatKey; inspectionThreadKey lo
      // vuelve a validar.
      replyGoalScope: inbound.replyToMessageId
        ? (goalNotifier.scopeBySentId(chatKey_, inbound.replyToMessageId) ?? undefined)
        : undefined,
      threadId: inbound.threadId,
    });
    await say(inbound, runMemoryCommand(memory, key), { quote: true });
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

  /**
   * HTML crudo de una ficha, por el MISMO camino con control SSRF (fetchPage). Solo lo
   * usa la lectura estructurada de tiendas de la vigilancia de precios; el extractor
   * con consenso necesita el marcado (JSON-LD/meta), no el texto plano.
   */
  const fetchPageHtml = async (url: string): Promise<string> =>
    (await fetchPage(url, { format: 'html', maxChars: 600_000 })).text;

  /**
   * /vigila <url> [objetivo=500€] [baja=15%] [palabra=agotado] [nombre]: avisa cuando
   * cambie el precio de una página, cuando baje de un objetivo o un %, o cuando una
   * palabra aparezca/desaparezca.
   */
  const cmdVigila = async (inbound: Inbound, args: string): Promise<void> => {
    let parsed: ReturnType<typeof parseVigilaArgs>;
    try {
      parsed = parseVigilaArgs(args);
    } catch (err) {
      return void (await say(inbound, err instanceof Error ? err.message : String(err), {
        quote: true,
      }));
    }
    const rawUrl = parsed?.url;
    if (!parsed || !rawUrl) {
      return void (await say(
        inbound,
        'Uso: /vigila <enlace> [objetivo=500€] [baja=15%] [palabra=agotado] [nombre]. Te aviso si cambia el precio, si baja de tu objetivo o un %, o si esa palabra aparece o desaparece. Si reconfiguras el mismo enlace, objetivo= y baja= reemplazan ambos ajustes anteriores: repite los dos si quieres conservarlos. /vigilando para ver la lista, /precio <id> para el histórico, /dejar_de_vigilar <id> para quitar una.',
        { quote: true },
      ));
    }
    if (!(await isFetchableResolved(rawUrl))) {
      return void (await say(inbound, 'Solo puedo vigilar enlaces públicos http(s).', {
        quote: true,
      }));
    }
    try {
      const w = pageWatches.add(inbound.chatId, rawUrl, parsed.label, parsed.keyword, {
        targetCents: parsed.targetCents ?? undefined,
        dropPct: parsed.dropPct ?? undefined,
      });
      const extra = [
        w.keyword ? `buscando "${w.keyword}"` : '',
        w.targetCents !== null ? `objetivo ${eur(w.targetCents)}` : '',
        w.dropPct !== null ? `aviso si baja un ${w.dropPct} %` : '',
      ]
        .filter(Boolean)
        .join(', ');
      await say(
        inbound,
        `Vale, vigilo ${w.label || w.url} (id ${w.id})${extra ? ` (${extra})` : ''}. Miro cada 2 horas y te aviso si cambia.`,
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
          .map(
            (w) =>
              `${w.id} - ${w.label || w.url} - último valor: ${w.lastValue || 'pendiente'}` +
              `${w.targetCents !== null ? ` - objetivo ${eur(w.targetCents)}` : ''}` +
              `${w.dropPct !== null ? ` - aviso si baja un ${w.dropPct} %` : ''}`,
          )
          .join('\n')
      : 'No vigilo ninguna página. Prueba /vigila <enlace>.';
    await say(inbound, text, { quote: true });
  };

  /** /precio <id>: histórico de la vigilancia (mín/mediana/máx, evolución y avisos). */
  const cmdPrecio = async (inbound: Inbound, args: string): Promise<void> => {
    const id = args.trim();
    const w = id
      ? pageWatches.list(inbound.chatId).find((x) => x.id === id || x.id.startsWith(id))
      : undefined;
    if (!w) {
      return void (await say(inbound, 'No encuentro ese id. Mira /vigilando.', { quote: true }));
    }
    await say(inbound, describeWatch(w, pageWatches.summary(w.id)), { quote: true });
  };

  /**
   * /compara <enlace>: el producto de esa ficha en las 7 tiendas, con precio de ficha
   * verificado (consenso) y emparejamiento declarado (EAN/modelo/título probable).
   */
  const cmdCompara = async (inbound: Inbound, args: string): Promise<void> => {
    const url = args.trim().split(/\s+/)[0] ?? '';
    if (!url) {
      return void (await say(
        inbound,
        'Uso: /compara <enlace de una ficha>. Busco ese mismo producto en Amazon, MediaMarkt, PcComponentes, Carrefour, El Corte Inglés, Fnac y Worten, y te digo el precio verificado en cada una.',
        { quote: true },
      ));
    }
    if (!(await isFetchableResolved(url))) {
      return void (await say(inbound, 'Solo puedo comparar enlaces públicos http(s).', {
        quote: true,
      }));
    }
    await say(inbound, 'Voy a compararlo en las 7 tiendas; tardo unos segundos por tienda.', {
      quote: true,
    });
    try {
      const report = await compareProduct(url, {
        fetchHtml: fetchPageHtml,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      });
      await say(inbound, describeCompare(report), { quote: true });
    } catch (err) {
      await say(inbound, err instanceof Error ? err.message : String(err), { quote: true });
    }
  };

  /**
   * /investiga <pregunta>: modo deep research con citas. Plan de sub-preguntas
   * (modelo, con plan deterministico de reserva), busqueda y lectura
   * multi-fuente via el enrutador web propio (tope 0 EUR, fail-closed) y
   * sintesis en espanol con citas [n] a fuentes con cita verbatim. Lo no
   * verificado queda marcado. Sin modelo disponible: informe de citas
   * textuales, nunca una sintesis inventada.
   */
  const researchLlm = async (): Promise<
    ((systemPrompt: string, userPrompt: string, maxTokens: number) => Promise<string>) | undefined
  > => {
    try {
      const handle = await createProviderHandle(config);
      return async (systemPrompt, userPrompt, maxTokens) => {
        const reply = await handle.models.completeSimple(
          handle.modelFor('pa-research'),
          {
            systemPrompt,
            messages: [
              {
                role: 'user',
                content: [{ type: 'text', text: userPrompt }],
                timestamp: Date.now(),
              },
            ],
          },
          { maxTokens, sessionId: 'pa-research', signal: AbortSignal.timeout(60_000) },
        );
        return reply.content
          .map((b) => (b.type === 'text' ? b.text : ''))
          .join('')
          .trim();
      };
    } catch (err) {
      log.warn('research: sin modelo, modo solo citas', { err });
      return undefined;
    }
  };

  const cmdInvestiga = async (inbound: Inbound, args: string): Promise<void> => {
    const question = args.trim();
    if (!question) {
      return void (await say(
        inbound,
        'Uso: /investiga <pregunta>. Hago un plan de sub-preguntas, busco y leo varias fuentes con el enrutador web (gratis) y te mando un informe con cada afirmacion citada [n] a su fuente verbatim. Lo que no pueda verificar queda marcado como tal.',
        { quote: true },
      ));
    }
    await say(
      inbound,
      'Me pongo: plan de preguntas, busqueda multi-fuente y sintesis con citas. Tardo 1-2 minutos.',
      { quote: true },
    );
    try {
      const router = new WebRouter({
        backends: await buildWebBackends(),
        maxCostEur: config.webMaxCostEur,
        metricsPath: paths.webMetrics,
      });
      const report = await deepResearch(question, {
        search: async (q, max) => (await router.routeSearch(q, { maxResults: max })).result.items,
        fetch: async (url, maxChars) => (await router.routeFetch(url, { maxChars })).result.text,
        llm: await researchLlm(),
      });
      await say(inbound, renderReport(report), { quote: true });
    } catch (err) {
      await say(inbound, err instanceof Error ? err.message : String(err), { quote: true });
    }
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
    const outcome = await pageWatches.check(w, fetchPageText, fetchPageHtml);
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
      playbooks: gestorStore.playbookOutcomes(),
      barge: bargeStats.totals(Date.now() - 7 * 24 * 3_600_000),
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

  let evolving = false;
  const runEvolveCycle = async (chatId: string): Promise<void> => {
    if (evolving) return;
    evolving = true;
    try {
      const out = await runEvolution({
        stateDir: paths.state,
        log: (m) => log.info(`evolve: ${m}`),
      });
      await telegram
        .send({ channel: 'telegram', account: telegram.account, chatId, text: out.text })
        .catch((err: unknown) => log.warn('evolve report failed', { err }));
    } finally {
      evolving = false;
    }
  };

  /** Domingo de madrugada, una vez por semana. Solo se lanza si hay proponedor configurado. */
  const evolveIfDue = async (chatId: string): Promise<void> => {
    if (!process.env.PA_EVOLVE_PROPOSER) return;
    if (!isEvolveDue(new Date(), weeklyState.lastSent('evolve'))) return;
    weeklyState.markSent('evolve', Date.now());
    await runEvolveCycle(chatId);
  };

  /**
   * Copia diaria del estado, las últimas 7. Solo cuenta como hecha si terminó bien: un
   * fallo se reintenta en el siguiente tick (10 min) y se AVISA al usuario una vez al día,
   * porque una copia que falla en silencio es peor que no tenerla.
   */
  const backupIfDue = async (chatId: string): Promise<void> => {
    if (!isBackupDue(new Date(), weeklyState.lastSent('backup'))) return;
    try {
      const r = runBackup({
        stateDir: paths.state,
        destDir: process.env.PA_BACKUP_DIR || undefined,
        mirrorDir: process.env.PA_BACKUP_MIRROR || undefined,
      });
      weeklyState.markSent('backup', Date.now());
      log.info('backup done', {
        dir: r.dir,
        databases: r.databases.length,
        pruned: r.pruned.length,
        mirror: r.mirrorDir,
      });
    } catch (err) {
      log.warn('backup failed', { err });
      if (Date.now() - weeklyState.lastSent('backup-aviso') < 20 * 3_600_000) return;
      weeklyState.markSent('backup-aviso', Date.now());
      await telegram
        .send({
          channel: 'telegram',
          account: telegram.account,
          chatId,
          text: `No he podido hacer la copia de seguridad de hoy (${(err as Error).message}). Lo reintento en unos minutos.`,
        })
        .catch((e: unknown) => log.warn('backup notice failed', { e }));
    }
  };

  /**
   * Consolidacion nocturna de la memoria (opt-in PA_MEMORY_CONSOLIDATE=1): fusiona
   * duplicados con supersedes y copia recuperable previa (src/memory/consolidate.ts).
   * Mismo patron que el backup de las 03:00: solo cuenta como hecha si termina bien;
   * un fallo se reintenta en el siguiente tick y queda en el log.
   */
  const consolidateIfDue = async (): Promise<void> => {
    if (process.env.PA_MEMORY_CONSOLIDATE !== '1') return;
    if (!isConsolidationDue(new Date(), weeklyState.lastSent('consolida'))) return;
    try {
      const report = await runConsolidation({
        store: memory,
        snapshot,
        backupDir: join(paths.state, 'memory-consolidation'),
        embedder: semanticRecall,
      });
      weeklyState.markSent('consolida', Date.now());
      log.info('memory consolidation finished', {
        scopes: report.scopes.length,
        backups: report.backups.length,
      });
    } catch (err) {
      log.warn('memory consolidation failed', { err: String(err) });
    }
  };

  const cmdEvolucion = async (inbound: Inbound, args: string): Promise<void> => {
    const a = args.trim();
    if (/^idea\b/i.test(a)) {
      try {
        addHypothesis(paths.state, a.replace(/^idea\s*/i, ''));
        await say(inbound, 'Anotada. La probará el próximo ciclo.', { quote: true });
      } catch (err) {
        await say(inbound, `No la he anotado: ${(err as Error).message}`, { quote: true });
      }
      return;
    }
    if (/^ahora$/i.test(a)) {
      if (evolving) {
        await say(inbound, 'Ya hay un ciclo en marcha.', { quote: true });
        return;
      }
      await say(inbound, 'Lanzo un ciclo de auto-mejora. Tarda; te cuento al terminar.', {
        quote: true,
      });
      void runEvolveCycle(inbound.chatId);
      return;
    }
    await say(inbound, describeLast(paths.state), { quote: true });
  };

  const cmdResumen = async (inbound: Inbound): Promise<void> => {
    await say(inbound, await weeklyText(inbound.chatId), { quote: true });
  };

  const PAGE_WATCH_EVERY_MS = 2 * 60 * 60 * 1000;
  const pageWatchTimer = setInterval(
    () => {
      for (const w of pageWatches.due(PAGE_WATCH_EVERY_MS)) void checkPageWatch(w.id);
      for (const userId of allowed) void sendWeeklyIfDue(String(userId));
      const first = [...allowed][0];
      if (first !== undefined) void evolveIfDue(String(first));
      if (first !== undefined) void backupIfDue(String(first));
      if (process.env.PA_MEMORY_CONSOLIDATE === '1') void consolidateIfDue();
    },
    10 * 60 * 1000,
  );
  pageWatchTimer.unref();

  // Vigilante de precios: bucle interno, sin hacer nada mientras pricewatch.json no exista o
  // tenga enabled=false. Ver src/watch/pricewatch-runner.ts.
  {
    // Disparador 'precio': todo aviso del vigilante pasa por makeNotify; se
    // envuelve UNA vez y además se emite el evento (global, scope '').
    const pwLog = {
      info: (m: string, f?: Record<string, unknown>) => log.info(m, f),
      warn: (m: string, f?: Record<string, unknown>) => log.warn(m, f),
    };
    const pwPath = process.env.PRICEWATCH_CONFIG ?? join(paths.state, 'pricewatch.json');
    const pwDeps = realDeps(pwPath, join(paths.state, 'pricewatch.sqlite'), pwLog, false, token);
    const pwNotify = pwDeps.makeNotify;
    pwDeps.makeNotify = (cfg) => {
      const notify = pwNotify(cfg);
      return async (text: string) => {
        void triggerEngine.emit({ type: 'precio', scope: '', text }).catch((err) => {
          log.warn('trigger precio falló', { err: String(err) });
        });
        return notify(text);
      };
    };
    startPricewatchLoop({
      mainBotToken: token,
      configPath: pwPath,
      stateDir: paths.state,
      log: pwLog,
      deps: pwDeps,
    });
  }

  // Carpeta automática de OCR (opt-in): PA_OCR_WATCH_DIR=<carpeta>, PA_OCR_WATCH_MODE=md|pdf|todo.
  // Ver docs/ocr-telegram.md.
  if (process.env.PA_OCR_WATCH_DIR?.trim()) {
    const ocrWatcher = new OcrFolderWatcher({
      dir: resolve(process.env.PA_OCR_WATCH_DIR.trim()),
      mode: watchModeFromEnv(process.env.PA_OCR_WATCH_MODE),
      makeDeps: windowsDeps,
      log: { info: (m, f) => log.info(m, f), warn: (m, f) => log.warn(m, f) },
    });
    ocrWatcher.start();
  }

  const startedAt = Date.now();

  /** /estado: salud de Asistenta desde Telegram (herramientas, log de hoy, vigilancias). */
  const cmdEstado = async (inbound: Inbound): Promise<void> => {
    const { localLlmHealthy } = await import('./autostart.js');
    const localLlmOk = await localLlmHealthy();
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
        ...(config.provider === 'opencode-local'
          ? [
              {
                name: 'LLM local (:4096)',
                ok: localLlmOk,
                note: localLlmOk
                  ? undefined
                  : 'modo degradado: Telegram y servicios activos; modelo no disponible',
              },
            ]
          : []),
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
      droppedReminders: readDroppedReminders(join(paths.state, 'dropped-reminders.jsonl')),
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

  /**
   * /memoria [listar | buscar <texto> | olvidar <id> | exportar]
   *
   * La memoria es lo que más confianza exige: ver qué recuerda, buscar dentro,
   * borrar una entrada y sacarla fuera (JSON) es lo que la hace auditable. El
   * scope lo pone el hilo, nunca el texto del comando.
   */
  const cmdMemoria = async (thread: Thread, inbound: Inbound, args: string): Promise<void> => {
    const [subRaw, ...rest] = args.trim().split(/\s+/).filter(Boolean);
    const sub = (subRaw ?? '').toLowerCase();
    const restText = rest.join(' ').trim();
    const vigentes = () => memory.all(thread.key).filter((e) => e.supersededBy === null);
    if (!sub || sub === 'listar' || sub === 'lista' || sub === 'list') {
      const entries = vigentes();
      if (!entries.length) {
        await say(inbound, 'Este chat no tiene memoria guardada todavía.', { quote: true });
        return;
      }
      await say(
        inbound,
        `Memoria de este chat (${entries.length}):\n${entries
          .map((e) => `- [${e.id}] (${e.date}) ${e.text}`)
          .join('\n')}`,
        { quote: true },
      );
      return;
    }
    if (sub === 'buscar' || sub === 'search') {
      if (!restText) {
        await say(inbound, 'Uso: /memoria buscar <texto>', { quote: true });
        return;
      }
      const hits = memory.recall(thread.key, restText).filter((e) => e.supersededBy === null);
      await say(
        inbound,
        hits.length
          ? hits.map((e) => `- [${e.id}] (${e.date}) ${e.text}`).join('\n')
          : 'No hay nada guardado que coincida con eso.',
        { quote: true },
      );
      return;
    }
    if (sub === 'olvidar' || sub === 'borrar' || sub === 'forget') {
      if (!restText) {
        await say(inbound, 'Uso: /memoria olvidar <id> (el id sale en /memoria)', {
          quote: true,
        });
        return;
      }
      const removed = memory.forget(thread.key, restText);
      await say(
        inbound,
        removed ? `Olvidado ${restText}.` : `No había nada con id ${restText} en este chat.`,
        { quote: true },
      );
      return;
    }
    if (sub === 'exportar' || sub === 'export') {
      const entries = memory.all(thread.key);
      const payload = {
        exportado: new Date().toISOString(),
        chat: thread.key,
        entradas: entries.map((e) => ({
          id: e.id,
          fecha: e.date,
          texto: e.text,
          tags: e.tags,
          sustituidaPor: e.supersededBy,
        })),
      };
      const bytes = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
      try {
        await telegram.sendDocumentBytes(
          Number(inbound.chatId),
          bytes,
          'memoria.json',
          `Memoria de este chat (${entries.length} entradas)`,
        );
      } catch (err) {
        log.warn('memory export send failed', { err });
        await say(
          inbound,
          `No pude enviar el archivo; aquí va:\n${bytes.toString('utf8').slice(0, 3500)}`,
          { quote: true },
        );
      }
      return;
    }
    await say(inbound, 'Uso: /memoria [listar | buscar <texto> | olvidar <id> | exportar]', {
      quote: true,
    });
  };

  /**
   * /exportar [id]: manda la conversación (turnos incluidos) como JSON.
   * Sin id exporta la última. Solo conversaciones de ESTE chat.
   */
  const cmdExportar = async (thread: Thread, inbound: Inbound, args: string): Promise<void> => {
    const id = args.trim();
    const session = id
      ? (sessions.recent(thread.key, 200).find((s) => s.id === id) ?? null)
      : (sessions.recent(thread.key, 1)[0] ?? null);
    if (!session) {
      await say(
        inbound,
        id
          ? 'No encuentro esa conversación en este chat.'
          : 'Todavía no hay ninguna conversación que exportar.',
        { quote: true },
      );
      return;
    }
    const exported = sessions.exportSession(session.id);
    if (!exported) {
      await say(inbound, 'No he podido leer esa conversación.', { quote: true });
      return;
    }
    const payload = { exportado: new Date().toISOString(), chat: thread.key, ...exported };
    const bytes = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
    try {
      await telegram.sendDocumentBytes(
        Number(inbound.chatId),
        bytes,
        `conversacion-${session.id.slice(0, 8)}.json`,
        `Conversación "${session.title}" (${exported.turns.length} turnos)`,
      );
    } catch (err) {
      log.warn('session export send failed', { err });
      await say(
        inbound,
        `No pude enviar el archivo; aquí va:\n${bytes.toString('utf8').slice(0, 3500)}`,
        { quote: true },
      );
    }
  };
  /** Perfil v2: hechos estructurados y por propietario, con export y borrado. */
  const cmdPerfil = async (inbound: Inbound, args: string): Promise<void> => {
    const [subRaw, ...rest] = args.trim().split(/\s+/).filter(Boolean);
    const sub = (subRaw ?? '').toLowerCase();
    const restText = rest.join(' ').trim();
    const owner = (await vaultGet('telegram:ownerId').catch(() => null)) ?? 'local';
    const profile = new OwnerProfile(join(paths.state, 'profile', `${owner}.json`));
    if (!sub || sub === 'listar' || sub === 'lista') {
      const facts = profile.load().filter((f) => !f.supersededBy);
      await say(
        inbound,
        facts.length
          ? `Perfil (${facts.length}):\n${facts
              .map((f) => `- [${f.id}] (${f.updatedAt.slice(0, 10)}) ${f.text}`)
              .join('\n')}`
          : 'El perfil está vacío. Guarda algo con /perfil guardar <texto>.',
        { quote: true },
      );
      return;
    }
    if (sub === 'guardar' || sub === 'add') {
      if (!restText) {
        await say(inbound, 'Uso: /perfil guardar <texto>', { quote: true });
        return;
      }
      try {
        const fact = profile.add(restText, { source: 'user' });
        await say(inbound, `Guardado en tu perfil (${fact.id}).`, { quote: true });
      } catch (err) {
        await say(
          inbound,
          `No lo he guardado: ${err instanceof Error ? err.message : String(err)}`,
          { quote: true },
        );
      }
      return;
    }
    if (sub === 'buscar' || sub === 'search') {
      const hits = profile.search(restText);
      await say(
        inbound,
        hits.length
          ? hits.map((f) => `- [${f.id}] ${f.text}`).join('\n')
          : 'No hay nada en tu perfil que coincida.',
        { quote: true },
      );
      return;
    }
    if (sub === 'olvidar' || sub === 'forget') {
      if (!restText) {
        await say(inbound, 'Uso: /perfil olvidar <id|texto>', { quote: true });
        return;
      }
      const removed = profile.forget(restText);
      await say(inbound, `Borrado del perfil: ${removed}.`, { quote: true });
      return;
    }
    if (sub === 'migrar') {
      const legacy = snapshot ? snapshot.load() : '';
      const migrated = profile.migrateFromLegacy(legacy);
      await say(inbound, `Migrados ${migrated} hechos del perfil antiguo.`, { quote: true });
      return;
    }
    if (sub === 'exportar' || sub === 'export') {
      const bytes = Buffer.from(profile.export(), 'utf8');
      try {
        await telegram.sendDocumentBytes(
          Number(inbound.chatId),
          bytes,
          'perfil.json',
          'Perfil estructurado (v2)',
        );
      } catch {
        await say(
          inbound,
          `No pude enviar el archivo; aquí va:\n${bytes.toString('utf8').slice(0, 3500)}`,
          { quote: true },
        );
      }
      return;
    }
    await say(
      inbound,
      'Uso: /perfil [listar | guardar <texto> | buscar <texto> | olvidar <id|texto> | migrar | exportar]',
      { quote: true },
    );
  };

  /** Importar una skill desde una URL (SKILL.md) con validación y saneado. */
  /** /calendario add <fecha> | <titulo>: escribe un evento en el ICS local. */
  const cmdCalendario = async (inbound: Inbound, args: string): Promise<void> => {
    if (!isOwnerDm(inbound, vigilanteOwnerId)) {
      await say(inbound, 'Este comando solo funciona en el chat privado del dueño.', {
        quote: true,
      });
      return;
    }
    const m = /^(?:add|anadir|añadir)\s+(.+?)\s*\|\s*(.+)$/i.exec(args.trim());
    if (!m) {
      await say(inbound, 'Uso: /calendario add 2026-11-02 18:00 | Dentista', { quote: true });
      return;
    }
    const start = new Date((m[1] ?? '').trim());
    const title = (m[2] ?? '').trim();
    if (Number.isNaN(start.getTime()) || !title) {
      await say(inbound, 'Fecha no válida. Usa 2026-11-02 18:00 | Título.', { quote: true });
      return;
    }
    const file = join(paths.state, 'calendar', 'local.ics');
    await appendEvent(file, { title, start });
    await say(
      inbound,
      'Añadido al calendario local (no a Google): ' +
        title +
        ' — ' +
        start.toLocaleString('es-ES') +
        '.',
      { quote: true },
    );
  };
  const cmdSkillsImport = async (inbound: Inbound, args: string): Promise<void> => {
    const url = args.trim();
    if (!url) {
      await say(inbound, 'Uso: /skills instalar <url de SKILL.md>', { quote: true });
      return;
    }
    try {
      const md = await fetchSkillMarkdown(url);
      const meta = await installSkill(md, async (text, m) => {
        const steps = text
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('---') && !/^(name|description):/.test(l))
          .slice(0, 40);
        skills.save({
          name: m.name,
          description: m.description,
          category: 'importadas',
          whenToUse: 'Cuando la tarea encaje con la descripción de la skill.',
          steps,
          notes: [`Importada de ${url}`],
        });
      });
      await say(inbound, `Skill instalada: ${meta.name} (${meta.id}).`, { quote: true });
    } catch (err) {
      await say(
        inbound,
        `No he podido instalarla: ${err instanceof Error ? err.message : String(err)}`,
        { quote: true },
      );
    }
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

  /** /steer <instrucción>: corrige lo que está haciendo ahora mismo sin pararlo. */
  const cmdSteer = async (inbound: Inbound, args: string): Promise<void> => {
    const r = steerChat(threads.values(), chatKey(inbound), args);
    const text = r.error
      ? r.error
      : r.sent === 0
        ? 'No hay nada en marcha ahora mismo. Escríbemelo como un mensaje normal.'
        : 'Anotado: lo leerá si aún le quedan pasos; si ya está terminando, repítemelo como mensaje normal.';
    await say(inbound, text, { quote: true });
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
      const bytes =
        recall.read(key, target.messageId) ??
        (await telegram.downloadFile(target.fileId, 25_000_000));
      if (!bytes) throw new Error('no he podido descargar el audio de Telegram');
      recall.retain(key, target.messageId, bytes);
      playable = await toPlayableAudio(bytes, target.mimeType);
      // The speakers are the wake microphone's other half.
      currentWake()?.suppress(PLAYBACK_SUPPRESS_MS);
      const res = await playAudioFile(playable, { volume });
      currentWake()?.suppress(WAKE_TAIL_MS);
      await say(
        inbound,
        res.ok
          ? `El reproductor completó ${res.seconds}s al volumen ${res.volumeSet}%. No puedo confirmar que se haya oído en la habitación. ` +
              playbackRestoreText(res)
          : `No he podido reproducirlo: ${res.detail}. ${playbackRestoreText(res)}`,
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
        '/screen [live|off] - captura ahora; live actualiza una foto; off detiene el directo',
        '/watch [segundos [fps]] - graba la pantalla y te manda el vídeo',
        '/topic <nombre> - abre una conversación; /topics para verlas',
        '/learn <nombre> ⬦ /learn end - guarda una rutina de lo que hagamos (con {parametros} es una macro)',
        '/routine <nombre> - repite una rutina (macro/<nombre> clave=valor con parámetros); con horario en palabras crea una programada',
        '/routines - lista de rutinas',
        '/agenda - calendario, pendientes, rutinas y objetivos; /agenda rutinas para horarios',
        '/cron [add horario | tarea ⬦ del <nombre>] - programa, lista y borra rutinas sin reiniciar',
        '/disparador <mensaje|archivo|precio> <coincidencia> | <rutina> - dispara una rutina cuando pasa algo (sin gastar tokens); /disparadores lista, /disparador del <n> borra',
        '/ocr [md|todo] - manda un PDF o foto con este pie: te lo devuelvo con texto seleccionable (md = Markdown, todo = ambos)',
        '/ojo [on|off] - ojo de águila: avisos proactivos (estado, encender, apagar)',
        '/ignora <n> ⬦ /ignorados - descarta un aviso [#n]; reglas de ignorar',
        '/avisos [menos|minimo|normal] - ritmo de avisos del filtro',
        '/memory - lo que recuerdo de ti',
        '/steer <instrucción> - cambia lo que estoy haciendo ahora mismo sin pararlo',
        '/pendientes - lo que te tengo que recordar',
        '/deshacer - repone el fichero que escribí por última vez como estaba antes',
        '/resolver <id> - marca un pendiente como resuelto',
        '/entreno_hoy ⬦ /ultimo ⬦ /peso - tu gimnasio en openGym (solo lectura)',
        '/resumen - lo que he hecho esta semana (te lo mando solo los domingos por la tarde)',
        '/evolucion - estado de la auto-mejora semanal; /evolucion idea <texto> ⬦ /evolucion ahora',
        '/estado - cómo estoy: herramientas, errores de hoy',
        '/vigila <enlace> [nombre] - te aviso si cambia el precio de esa página',
        '/vigilando ⬦ /dejar_de_vigilar <id> - lista o quita lo que vigilo',
        '/buscar <texto> - busca en conversaciones pasadas',
        '/investiga <pregunta> - investigo a fondo: varias fuentes y un informe con citas',
        '/voice on|off - contestar con voz',
        '/wake on|off - escuchar mi nombre en el micrófono',
        '/conversacion on|off|estado|corte - tras mi nombre, hablar sin repetirlo (cortarme: apagado por defecto)',
        '/permisos [revocar <herramienta>|todo] - los permisos "siempre" que me diste: verlos y quitarlos',
        '/camera [on|off|clip|av [seg]] - foto, directo, vídeo o vídeo con tu voz',
        '/play [volumen] - suena en el PC el último audio que me mandaste',
        '/mic [segundos] - escuchar lo que oye el microfono',
        '/screen live [intervalo_segundos] - foto en directo; /screen off para parar',
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
  /**
   * Run any thread work through the thread's tail.
   *
   * A `PersonalAgent` cannot run two turns at once (pi rejects "already
   * processing"), and the fields a run owns (`#externalAbort`,
   * `#runToolCallCeiling`, the tool-call memo) are shared. Messages already queue
   * here; routines, wake-word turns and `/learn end` used to call the agent
   * directly, so a routine firing during a live turn could collide. Everything
   * that touches the thread's agent goes through this now.
   */
  const enqueue = <T>(thread: Thread, task: () => Promise<T>): Promise<T> => {
    const next = thread.tail.then(task);
    thread.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const runTurn = async (
    thread: Thread,
    inbound: Inbound,
    text: string,
    opts: { images?: Inbound['images']; spoken?: (text: string) => Promise<void> },
  ): Promise<void> => {
    const generation = thread.generation;
    thread.active = true;
    // Which message this turn is answering, so a tool that sends something back can
    // quote it. Replaced per turn, because one thread serves many messages.
    threadInbound.set(thread.key, inbound);
    let lastSummary: string | null = null;
    // One episodic session per turn, closed in the finally below even when the
    // turn was cancelled or failed: a turn that produced no answer still
    // happened, and /buscar must be able to find it.
    let sessionId = '';
    safeRemember(() => {
      sessionId = sessions.begin(thread.key, inbound.text.slice(0, 80));
      // Las palabras del usuario también se guardan (acotadas): sin ellas /buscar
      // y la acción `history` no pueden recordar lo que se PIDIÓ, solo la respuesta.
      if (sessionId) sessions.addTurn(sessionId, 'user', inbound.text.slice(0, 4000));
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

    /**
     * A capture the user asked for is sent by the channel, not by the model.
     *
     * This used to be a rule in the system prompt, and it failed the same way every
     * time: the model read "pass me a screenshot when you have it", decided it had
     * something to do first, and the reply arrived with no picture and an excuse. A
     * prompt rule is a request; this is the thing itself happening.
     *
     * So the daemon takes the picture and puts it in the chat before the turn even
     * starts. The model can also send another one later (there is a `send` flag on the
     * screenshot actions) but it can no longer forget the first one, and the user gets
     * to see the machine while the agent is still working on it.
     */
    if (wantsScreenshot(inbound.text)) {
      void sendScreenShot(inbound, 'Así está el PC ahora mismo.', thread.key).catch(
        (err: unknown) => {
          log.warn('auto screenshot failed', { err });
        },
      );
    }

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
            text: progressNote({
              elapsedMs: now - startedAt,
              summary: lastSummary,
              toolCalls: toolNames.length,
            }),
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
      let photoDownloadNote = '';
      if (!images?.length && inbound.photoFileId) {
        try {
          const data = await telegram.downloadPhoto(inbound.photoFileId);
          if (data) {
            images = [{ type: 'image', mimeType: 'image/jpeg', data: data.toString('base64') }];
          } else {
            photoDownloadNote = '[Foto: Telegram no devolvió la imagen; no se vio ni se indexó.]';
          }
        } catch (err) {
          log.warn('photo download failed', { err });
          photoDownloadNote = '[Foto: no pude descargarla; no se vio ni se indexó.]';
        }
      }

      // Fotos e imágenes: se lee el texto visible con el OCR local de Windows y se indexa
      // bajo el mismo hilo (la memoria documental nunca cruza chats). La imagen no se guarda.
      const indexImage = async (
        bytes: Buffer,
        mime: string,
        ref: string,
        caption: string | undefined,
        label: string,
      ): Promise<string> => {
        try {
          const out = await ocrImageBytes(bytes, mime, { ocrAvailable, ocrImage });
          const indexed =
            out.status === 'ok' ? docMemory.indexOcr(thread.key, ref, out.text, caption) : null;
          return imageNote(label, out, indexed);
        } catch (err) {
          log.warn('image index failed', { err: String(err) });
          return `[${label}: no se indexó: falló la lectura de la imagen.]`;
        }
      };

      let documentNote = photoDownloadNote;
      if (inbound.photoFileId && images?.[0]?.data) {
        documentNote = await indexImage(
          Buffer.from(images[0].data, 'base64'),
          'image/jpeg',
          inbound.photoFileId,
          inbound.text,
          'Foto',
        );
      }
      if (inbound.documentFileId) {
        const label = inbound.documentName ?? inbound.documentMimeType ?? 'documento';
        const docMime = inbound.documentMimeType?.toLowerCase() ?? '';
        if (imageExtension(docMime)) {
          const bytes = await telegram.downloadFile(inbound.documentFileId).catch(() => null);
          documentNote = bytes
            ? await indexImage(
                bytes,
                docMime,
                inbound.documentFileId,
                inbound.documentName ?? inbound.text,
                `Imagen reenviada "${label}"`,
              )
            : `[Imagen reenviada: ${label}. Telegram no devolvió el archivo.]`;
        } else if (docMime.startsWith('audio/')) {
          const bytes = await telegram.downloadFile(inbound.documentFileId).catch(() => null);
          if (!bytes) {
            documentNote = `[Audio reenviado: ${label}. Telegram no devolvió el archivo.]`;
          } else {
            try {
              const heard = await transcribeVoiceNote(bytes, { mimeType: docMime });
              const indexed = docMemory.indexTranscript(
                thread.key,
                inbound.messageId,
                heard.text,
                inbound.documentName ?? inbound.text,
              );
              documentNote = indexed
                ? `[Audio reenviado: "${label}", transcrito e indexado${indexed.truncated ? ' PARCIALMENTE (la transcripción era demasiado larga)' : ''} en la memoria documental (${indexed.chars} caracteres)${heard.truncated ? ', leyendo solo los primeros 15 minutos del audio' : ''}. La transcripción puede tener errores. Úsalo con la herramienta documents cuando pregunte por él.]`
                : `[Audio reenviado: ${label}. No se entendió ninguna palabra; no se indexó nada.]`;
            } catch (err) {
              log.warn('audio document index failed', { err: String(err) });
              documentNote = `[Audio reenviado: ${label}. No se pudo transcribir: ${err instanceof Error ? err.message : String(err)}]`;
            }
          }
        } else if (!canExtract(inbound.documentMimeType, inbound.documentName)) {
          documentNote = `[Documento reenviado: ${label}. No se indexó: por ahora leo PDF con texto, archivos de texto, Word/Excel/PowerPoint modernos (docx, xlsx, pptx), LibreOffice (odt, ods, odp), imágenes con texto y audios (notas de voz, mp3, m4a, wav). Los formatos antiguos (doc, xls, ppt) no.]`;
        } else {
          try {
            const bytes = await telegram.downloadFile(inbound.documentFileId);
            if (!bytes) {
              documentNote = `[Documento reenviado: ${label}. Telegram no devolvió el archivo.]`;
            } else {
              // The thread key is the memory scope everywhere: the documents
              // tool reads with () => thread.key, so indexing MUST use the
              // same string or nothing is findable even in the same chat.
              const indexed = await docMemory.index(
                thread.key,
                {
                  fileId: inbound.documentFileId,
                  name: inbound.documentName,
                  mimeType: inbound.documentMimeType,
                },
                bytes,
              );
              documentNote = indexed
                ? indexed.truncated
                  ? `[Documento reenviado: "${indexed.title}", indexado PARCIALMENTE en la memoria documental (${indexed.chars} primeros caracteres indexados; el resto no cabe). Úsalo con la herramienta documents cuando pregunte por él.]`
                  : `[Documento reenviado: "${indexed.title}", indexado en la memoria documental (${indexed.chunks} fragmentos, ${indexed.chars} caracteres). Úsalo con la herramienta documents cuando pregunte por él.]`
                : `[Documento reenviado: ${label}. No tenía texto extraíble (un PDF escaneado son imágenes, no texto: por ahora no leo imágenes dentro de un PDF; si quieres, mándame las páginas como fotos).]`;
            }
          } catch (err) {
            log.warn('document index failed', { err });
            documentNote = `[Documento reenviado: ${label}. Falló la indexación: ${err instanceof Error ? err.message : String(err)}]`;
          }
        }
      }

      let prompt = text;
      if (inbound.audioFileId) {
        const bytes = await telegram.downloadFile(inbound.audioFileId);
        if (!bytes) {
          await say(inbound, 'No he podido descargar el audio.', { quote: true });
          return;
        }
        recall.retain(chatKey(inbound), inbound.messageId, bytes);
        await telegram.action(inbound.chatId, 'typing');
        try {
          const heard = await transcribeVoiceNote(bytes, { mimeType: inbound.audioMimeType });
          // Marked as a transcription so the model does not treat a misheard word as
          // something the user typed, and so the reply can be spoken back.
          prompt = `[Nota de voz transcrita${heard.truncated ? ' (audio largo: solo los primeros 15 minutos)' : ''}] ${heard.text}`;
          log.info('voice transcribed', {
            seconds: heard.durationSeconds,
            chars: heard.text.length,
          });
          // Remembered with the handle, so "suéltame ese audio" two messages later
          // has something to act on.
          recall.setTranscript(chatKey(inbound), inbound.messageId, heard.text);
          try {
            docMemory.indexTranscript(thread.key, inbound.messageId, heard.text, inbound.text);
          } catch (err) {
            // The transcript is already in the turn and in the short-term recall;
            // losing only its long-term index must not kill the turn.
            log.warn('transcript index failed', { err });
          }
        } catch (err) {
          await say(
            inbound,
            `No he entendido la nota de voz: ${err instanceof Error ? err.message : String(err)}`,
            { quote: true },
          );
          return;
        }
      }

      rememberUserRequest(thread, prompt);
      if (documentNote) prompt = prompt.trim() ? `${documentNote}\n${prompt}` : documentNote;

      if (!prompt.trim() && !images?.length) {
        await say(inbound, 'No he visto texto ni imagen en ese mensaje.', { quote: true });
        return;
      }

      // Memory and routines are injected as a system message, so they read as
      // standing context rather than as something the user just said.
      thread.agent.attachContext(
        buildContextNote(
          thread,
          store,
          memory,
          snapshot,
          workstreams,
          skills,
          sessions,
          ownerProfile,
        ),
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
      const learnDay = new Date().toISOString().slice(0, 10);
      const learned = recordLessons(skills, result.steps, learnDay);
      if (learned.length) log.info('lessons saved', { thread: thread.name, ids: learned });
      // Bucle Hermes: una lección reincidente mejora el skill afectado al
      // momento, sin esperar al evolve semanal. Solo anota; nunca reescribe.
      const refined = refineFromLessons(skills, learned, learnDay);
      if (refined.length) log.info('skills refined in use', { thread: thread.name, ids: refined });

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

      // Coste y continuidad del turno: tokens reales en el libro diario, la
      // respuesta completa cacheada para "Dime más", y aviso si el presupuesto
      // diario (PA_DAILY_BUDGET_EUR) está agotado.
      recordUsage({
        sessionId: thread.key,
        model: config.model,
        inputTokens: result.inputTokens ?? 0,
        outputTokens: result.outputTokens ?? 0,
        kind: 'turn',
      });
      if (result.text.trim()) cacheFullReply(thread.key, result.text.trim());
      if (config.dailyBudgetEur > 0 && dailyBudgetExceeded(config.dailyBudgetEur)) {
        const budgetDay = new Date().toISOString().slice(0, 10);
        if (budgetWarnedDay !== budgetDay) {
          budgetWarnedDay = budgetDay;
          void say(inbound, 'Aviso: has alcanzado el presupuesto diario configurado.', {
            quote: true,
          }).catch(() => {});
        }
      }

      const text2 =
        result.text.trim() || (result.error ? `Fallo: ${result.error}` : 'Sin respuesta.');
      await answer(thread, inbound, text2);
      // Spoken sessions (capability 6) read the answer out loud on this machine. After
      // the chat copy, so a TTS failure never costs the text.
      if (opts.spoken && text2.trim()) {
        await opts.spoken(text2).catch((err: unknown) => log.warn('spoken answer failed', { err }));
      }
      // The answer itself joins the session record: it is what /buscar reads back
      // when the user asks "what did you tell me about that?".
      const finalText = result.text;
      safeRemember(() => sessions.addTurn(sessionId, 'assistant', finalText));

      // What happened, kept where the user can ask about it later: "¿qué enviaste
      // anoche?" is a question about a past action, and without a record the honest
      // answer is "no sé".
      //
      // One line per action, not one per turn. A log of "turn, turn, turn" answers
      // nothing: the whole point is that the user can read back what was actually
      // done, which tool touched what, and whether it worked.
      // One line per tool used, not one per call: ten clicks on one button are one
      // fact ("clicked"), not ten lines of noise.
      const used = [...new Set(toolNames)];
      for (const name of used) {
        actions.record({
          actor: 'asistenta',
          action: name,
          target: thread.name,
          result: result.error ? 'error' : 'ok',
          // Summarised by a human, not a dump of arguments: an argument list can hold
          // a password, a card number or a whole file, and this file lives on disk.
          detail: summarizeToolUse(lastSummary ?? 'recibido'),
        });
      }
      // The reply itself, so "what did you tell me?" is answerable too.
      actions.record({
        actor: 'asistenta',
        action: 'reply',
        target: thread.name,
        result: result.error ? 'error' : 'ok',
        detail: text2.slice(0, 80).replace(/\s+/g, ' '),
      });
      // Disparador (a) del multi-agente (ROADMAP.md): builds grandes
      // multi-archivo de forma habitual. Un "build" es una peticion que acaba
      // con 2+ RUTAS distintas escritas OK con la tool write (FileWriteTracker
      // las resuelve contra el cwd del tool y en minusculas en Windows, sobre
      // tool_execution_end; reintentos y fallos no cuentan). Alcance declarado:
      // dedup por RUTA, no por archivo (symlinks/hardlinks al mismo archivo
      // cuentan como dos), y escrituras via shell no cuentan (no hay forma
      // honesta de atribuirlas).
      const filesWritten = result.filesWritten;
      if (filesWritten >= 2) {
        actions.record({
          actor: 'asistenta',
          action: 'build_multi',
          target: thread.name,
          result: result.error ? 'error' : 'ok',
          detail: `${filesWritten} archivos`,
        });
      }
      // A turn-level line, for counting. Never the only record of a turn.
      actions.record({
        actor: 'asistenta',
        action: 'turn',
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
        // Modelo de usuario auto-enriquecido: el mismo hecho visto en
        // AUTOSAVE_DAYS días distintos deja de ser pregunta y se guarda solo,
        // marcado [auto], visible con action=profile y borrable con
        // action=forget_profile. Antes del umbral se pregunta como siempre.
        let autosaved = false;
        try {
          if (nudgeTracker.record(nudge.suggestion, new Date().toISOString().slice(0, 10))) {
            const first = nudge.suggestion.indexOf('"');
            const last = nudge.suggestion.lastIndexOf('"');
            const clause =
              first >= 0 && last > first ? nudge.suggestion.slice(first + 1, last) : '';
            if (clause && !looksLikeCredential(clause)) {
              const saved = snapshot.appendEntry(`[auto] ${clause}`);
              if (saved.ok) autosaved = true;
            }
          }
        } catch (err) {
          log.warn('profile autosave failed', { err: String(err) });
        }
        if (autosaved) {
          log.info('profile autosaved', { thread: thread.name });
          await say(
            inbound,
            'Lo he apuntado en tu perfil (lo repites a menudo). Si no quieres que lo recuerde, dímelo y lo borro.',
            { quote: true },
          ).catch(() => {});
        } else {
          await say(inbound, nudge.suggestion, { quote: true }).catch(() => {});
        }
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
      for (const key of purchaseAnswers.keys()) {
        if (key.startsWith(`${thread.key}:`)) purchaseAnswers.delete(key);
      }
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
    // Motor oww: el detector solo sabe QUE sono la palabra, no lo que vino
    // detras, asi que `heard` es siempre la palabra sola y request queda
    // vacio. Sin abrir sesion aqui, cada wake seria un no-op silencioso.
    if ((conversationOn || loadConfig().voiceWake.engine === 'oww') && !session) {
      // Capability 6: the wake word opens a spoken session; the request that came with
      // it is its first turn. The chat is fixed for the whole session.
      const opened = openSession(chat);
      if (opened) {
        if (request) await opened.submit(request);
        else await speakAloud('Dime.', opened);
        return;
      }
    }
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
      await enqueue(thread, () => runTurn(thread, inbound, inbound.text, {}));
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

  // ---- spoken conversation (capability 6, V1) --------------------------------

  /** Opt-in and off at every boot: it is the switch that lets the wake word open a session. */
  let conversationOn = false;
  let session: ConversationSession | null = null;
  let sessionPlayback: Playback | null = null;
  let activeSpeech: { abort(): void } | null = null;
  /** How easily talking over the agent cuts it off. Not persisted. */
  let bargeLevel: BargeInLevel = 'altavoces';
  let conversationCount = 0;
  let lastConversationEnd = '';
  const speaker = createMciSpeaker();
  // Confirmación por forma (Silero VAD) de los cortes: perezoso, se descarga y
  // carga en el primer candidato ruidoso, y se comparte entre sesiones. Con el
  // corte apagado nunca llega a usarse.
  const bargeVadScorer = createBargeVadScorer({ modelDir: paths.models });

  // Verificación de hablante (brecha 3b): SOLO con PA_SPEAKER_VERIFY=1 y con al
  // menos una voz enrolada (`pa voice enroll`). Sin perfiles la puerta queda
  // desactivada (avisado): una puerta que rechaza todo dejaría la voz muerta.
  let speakerGate: ((samples: Float32Array) => Promise<boolean>) | undefined;
  let speakerRejected = 0;
  if (process.env.PA_SPEAKER_VERIFY === '1') {
    const verifier = await SpeakerVerifier.load(speakerProfilesFile(), speakerGateConfigFromEnv());
    if (verifier.list().length === 0) {
      log.warn('PA_SPEAKER_VERIFY=1 pero no hay voces enroladas; la puerta queda desactivada');
    } else {
      speakerGate = async (samples) => (await verifier.verify(samples)).accepted;
    }
  }

  /**
   * Read an answer out loud on this machine's speakers, phrase by phrase, interruptible.
   * Never touches the system volume. Runs inside the session's `speak`, so the agent's
   * own voice is not taken for a request and the user talking over it stops the sound.
   */
  const speakAloud = async (text: string, owner: ConversationSession): Promise<void> => {
    const phrases = splitPhrases(trimForSpeech(text));
    if (phrases.length === 0 || session !== owner) return;
    const aloud = createAloudSpeaker(phrases, {
      tts,
      speaker,
      directory: paths.voice,
      isOwnerCurrent: () => session === owner,
      setPlayback: (playback) => {
        sessionPlayback = playback;
      },
    });
    activeSpeech = aloud;
    try {
      await owner.speak((ctl) => aloud.run(ctl), {
        stop: () => aloud.abort(),
        text: phrases.join(' '),
      });
    } finally {
      activeSpeech = null;
    }
  };

  const closeSessionText = (reason: string, detail?: string): string =>
    reason === 'inactividad'
      ? 'Conversación por voz cerrada por inactividad. Di "asistenta" para abrir otra.'
      : reason === 'cierre'
        ? 'Conversación por voz cerrada. Di "asistenta" para abrir otra.'
        : reason === 'apagado'
          ? 'Conversación por voz cerrada.'
          : `Conversación por voz cerrada por un fallo${detail ? `: ${detail}` : ''}.`;

  const endSession = (
    reason: 'apagado' | 'fallo' | 'cierre' | 'inactividad',
    detail?: string,
  ): void => {
    const current = session;
    if (!current) return;
    current.close(reason, detail);
    // The close hook (below) does the rest; this keeps /off and shutdown synchronous.
  };

  const openSession = (
    chat: {
      key: string;
      chatId: string;
      threadId?: string;
    },
    opts: { force?: boolean } = {},
  ): ConversationSession | null => {
    const listener = currentWake();
    // force: the TV remote button is an activation of its own — pressing a
    // physical button IS the intent — so it opens a session even with
    // conversation mode off (it resets at every boot, which used to make the
    // button a silent no-op; audit, "botón TV").
    if ((!conversationOn && !opts.force) || !listener || session) return session;
    const levelAtOpen = bargeLevel;
    const created = new ConversationSession({
      bargeIn: levelAtOpen,
      bargeVad: levelAtOpen === 'off' ? undefined : bargeVadScorer,
      speakerGate,
      onSpeakerRejected: () => {
        speakerRejected++;
        log.info('voz no enrolada rechazada en la conversación', { total: speakerRejected });
      },
      transcriber: (samples) => defaultTranscriber(samples),
      onUtterance: async (heard) => {
        const inbound: Inbound = {
          channel: 'telegram',
          account: telegram.account,
          chatId: chat.chatId,
          threadId: chat.threadId,
          userId: String(chat.chatId),
          displayName: 'conversación por voz',
          text: `[dicho en voz alta ante el microfono] ${heard}`,
          authorised: true,
          messageId: `voz-${++wakeCount}`,
          receivedAt: new Date().toISOString(),
        };
        const thread = await getOrCreateThread(chat.key, 'main', 'principal');
        messageThread.set(`${chat.key}:${inbound.messageId}`, thread.key);
        log.info('voice session utterance', { chars: heard.length, chatId: chat.chatId });
        // The turn goes through runTurn like any message: same gate, same mutex. An
        // approval it needs is still asked with Telegram buttons; nothing spoken is read
        // as a yes. Encolado en el hilo: la voz no puede solaparse con un turno vivo.
        await enqueue(thread, () =>
          runTurn(thread, inbound, inbound.text, {
            spoken: (answer) => speakAloud(answer, created),
          }),
        );
      },
      onClose: (reason, detail) => {
        if (session === created) {
          session = null;
        }
        sessionPlayback?.stop();
        activeSpeech?.abort();
        currentWake()?.hold(false);
        lastConversationEnd = `${reason}${detail ? `: ${detail}` : ''}`;
        const closeStats = created.stats();
        bargeStats.record({
          endedAt: Date.now(),
          level: levelAtOpen,
          bargeIns: closeStats.bargeIns,
          trueIns: closeStats.bargeTrue,
          falseNoise: closeStats.bargeFalseNoise,
          falseEcho: closeStats.bargeFalseEcho,
          unclassified: closeStats.bargeUnclassified,
          utterances: closeStats.utterances,
        });
        log.info('voice session closed', { reason, detail });
        void notifyLastChat(closeSessionText(reason, detail)).catch(() => {});
      },
    });
    session = created;
    conversationCount++;
    listener.hold(true);
    log.info('voice session opened', { chatId: chat.chatId, n: conversationCount });
    return created;
  };

  const startWake = async (): Promise<void> => {
    if (!desktop) throw new Error('sin micrófono en modo servidor');
    let told = false;
    const wakeCfg = loadConfig().voiceWake;
    const listener = new WakeWordListener({
      word: wakeWord,
      engine: wakeCfg.engine,
      ...(wakeCfg.engine === 'oww'
        ? {
            oww: {
              modelDir: join(paths.models, 'oww'),
              wordModelFile: wakeCfg.owwModel,
              threshold: wakeCfg.owwThreshold,
            },
          }
        : {}),
      // Whisper has no vocabulary for a custom word: "Chochi" came back as
      // "Choci", "Chuchis", "Chocchi" or dropped entirely. The initial prompt
      // gives it a spelling to copy instead of one to invent.
      initialPrompt: wakeWord,
      onAudio: (pcm) => session?.feed(pcm),
      onWake: (heard) => {
        // Deliberately not awaited: a wake starts a whole turn, and the listener's
        // job is done the moment it has handed the text over.
        void handleWake(heard).catch((err: unknown) => log.error('wake turn failed', { err }));
      },
      onError: (err) => {
        log.warn('wake listener error', { err });
        // Capture failure ends any spoken session too: its audio is gone.
        endSession('fallo', err.message);
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
    log.info('wake word listening', {
      word: wakeWord,
      engine: wakeCfg.engine,
      ...listener.stats(),
    });
  };

  const stopWake = async (): Promise<void> => {
    const listener = wake;
    if (!listener) return;
    wake = null;
    endSession('apagado');
    await listener.stop();
    log.info('wake word stopped', listener.stats());
  };

  /**
   * El boton del mando: una via de activacion propia, no un alias de la
   * palabra de activacion. handleWake('') con la conversacion apagada (cada
   * reinicio la apaga) caia en el log "wake word heard with no request" y no
   * hacia NADA — el no-op silencioso de la auditoria, contradiciendo el
   * comentario de abajo. La decision vive en tvButtonAction (exportada, pura)
   * para que el canario la corra sin daemon.
   */
  const handleButton = async (source: string): Promise<void> => {
    const chat = lastChat;
    const action = tvButtonAction({
      hasChat: Boolean(chat),
      hasListener: Boolean(currentWake()),
      sessionOpen: Boolean(session),
    });
    if (action === 'no-chat') {
      log.warn('tv button pressed but nobody has talked yet', { source });
      return;
    }
    if (action === 'need-mic') {
      // Sin listener no hay audio que darle a la sesion: se dice, no se calla.
      log.info('tv button pressed with the mic off', { source });
      void notifyLastChat(
        'Has pulsado el botón del mando pero el micrófono está apagado: actívalo con /wake on o /conversacion on.',
      ).catch(() => {});
      return;
    }
    if (action === 'already-open') {
      log.info('tv button pressed with a session already open', { source });
      return;
    }
    const opened = openSession(chat as NonNullable<typeof chat>, { force: true });
    if (opened) {
      log.info('tv button opened a voice session', {
        source,
        chatId: (chat as { chatId: string }).chatId,
      });
      // speakAloud directo: envolverlo en opened.speak() anidaria dos speak y
      // el interior volveria 'fin' sin sonar (conversation.ts: guarda de estado).
      await speakAloud('Dime.', opened);
    }
  };

  /**
   * Listener HTTP del boton del mando (:8765).
   *
   * Vive fuera de `wake` a proposito: el boton es una via de activacion mas,
   * no una variante del microfono. Con la palabra de activacion apagada el
   * boton sigue teniendo que funcionar, asi que arrancarlo y apagarlo aqui
   * (y no dentro de startWake/stopWake) lo mantiene independiente del micro.
   *
   * Null hasta que arranca, otra vez tras un fallo de listen: un daemon al que
   * le ocupa el puerto 8765 no es un daemon roto, y las tres referencias lo
   * tratan como opcional.
   */
  let tvButton: TvButtonListener | null = null;

  /**
   * El listener vivo, o null.
   *
   * Mismo motivo que `currentWake`: solo se asigna desde dentro de closures y
   * el analisis de flujo lo reduce a `null` en todos los puntos de
   * `serveCommand` que se ejecutan antes de que existan.
   */
  const currentTvButton = (): TvButtonListener | null => tvButton;

  const startTvButton = async (): Promise<void> => {
    if (tvButton) return;
    const listener = startTvButtonListener({
      token: await vaultGet('tv:buttonToken'),
      onButton: (source) => handleButton(source).then(() => log.info('tv button wake', { source })),
    });
    tvButton = listener;
    try {
      await listener.ready;
      log.info('tv button listener ready', { port: listener.port });
    } catch (err) {
      // Puerto ocupado o bind imposible: el boton no funcionara, pero el resto
      // del daemon sigue. Se dice claro en el log en vez de caer en silencio.
      tvButton = null;
      log.warn('tv button listener no arranco; el boton del mando no funcionara', { err });
    }
  };

  /**
   * Canal de entrada de alertas (CavaAI -> dueno). Sin `alerts:token` en el vault no
   * arranca. Entrega solo texto plano al DM del dueno; nunca pasa por el agente.
   * Ver docs/alerts-inbox.md.
   */
  let alertInbox: AlertInbox | null = null;
  const startAlerts = async (): Promise<void> => {
    if (alertInbox) return;
    const token = await vaultGet('alerts:token');
    const portRaw = Number((await vaultGet('alerts:port'))?.trim());
    const listener = startAlertInbox({
      token,
      host: (await vaultGet('alerts:host'))?.trim() || undefined,
      port: Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : undefined,
      send: async (text) => {
        const chatId = resolveOwnerDmChatId(
          [...threads.values()].map((t) => t.chatKey),
          vigilanteOwnerId,
        );
        if (!chatId) return false;
        const id = await telegram.send({
          channel: 'telegram',
          account: telegram.account,
          chatId,
          text,
        });
        return Boolean(id);
      },
    });
    if (!listener) return;
    alertInbox = listener;
    try {
      await listener.ready;
      log.info('alert inbox ready', { port: listener.port });
    } catch (err) {
      alertInbox = null;
      log.warn('alert inbox no arranco; las alertas de CavaAI no llegaran', { err });
    }
  };
  const stopAlerts = async (): Promise<void> => {
    const listener = alertInbox;
    alertInbox = null;
    await listener?.close().catch(() => undefined);
  };

  const stopTvButton = async (strict = false): Promise<void> => {
    const listener = tvButton;
    if (!listener) return;
    tvButton = null;
    await listener.close().catch((error: unknown) => {
      if (strict) throw error;
    });
    log.info('tv button listener stopped');
  };

  /**
   * `/permisos [revocar <herramienta>|todo]`: los permisos "siempre" viven en
   * approvals.db y los cachea cada gate en memoria; revocar limpia AMBOS (la
   * lógica y sus límites en runPermisosCommand). Solo el dueño: cambia la
   * postura de seguridad del daemon entero.
   */
  const cmdPermisos = async (inbound: Inbound, args: string): Promise<void> => {
    if (!isOwnerDm(inbound, vigilanteOwnerId)) {
      await say(inbound, 'Este comando solo funciona en el chat privado del dueño.', {
        quote: true,
      });
      return;
    }
    const gates = [...threads.values()].map((thread) => thread.gate);
    await say(inbound, runPermisosCommand(gates, approvalsDb, args), { quote: true });
  };

  const cmdConversacion = async (inbound: Inbound, args: string): Promise<void> => {
    const want = args.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (want === 'estado' || want === '') {
      const st = session?.stats();
      const bargeHist = bargeStats.totals();
      const bargeRate = bargeFalseRate(bargeHist);
      await say(
        inbound,
        `Conversación por voz: ${conversationOn ? 'activada' : 'apagada'}. ` +
          (st
            ? `Sesión abierta (${st.state}, ${st.utterances} frases, ${st.bargeIns} interrupciones (${st.bargeTrue} uso estimado, ${st.bargeFalseNoise + st.bargeFalseEcho} falsas estimadas, ${st.bargeUnclassified} sin clasificar${st.bargePending > 0 ? `, ${st.bargePending} pendiente de clasificar` : ''}${st.bargeVadRejected > 0 ? `, ${st.bargeVadRejected} ruidos rechazados por el detector` : ''}), lo último que he oído: "${st.lastHeard}"${st.lastError ? `, último fallo: ${st.lastError}` : ''}).`
            : `Sin sesión abierta${lastConversationEnd ? ` (la última se cerró: ${lastConversationEnd})` : ''}.`) +
          (currentWake()?.isRunning()
            ? ''
            : ' El micrófono está cerrado: /conversacion on lo abre.') +
          (bargeHist.bargeIns > 0
            ? ` Histórico de cortes: ${bargeHist.bargeIns} interrupciones en ${bargeHist.sessions} sesiones (${bargeClassified(bargeHist)} clasificadas${bargeRate !== null ? `, ${Math.round(bargeRate * 100)}% falsas estimadas` : ''}${bargeHist.unclassified > 0 ? `, ${bargeHist.unclassified} sin clasificar` : ''}).`
            : ''),
        { quote: true },
      );
      return;
    }
    if (want === 'corte') {
      const level = args.trim().split(/\s+/)[1]?.toLowerCase() ?? '';
      if (level !== 'off' && level !== 'altavoces' && level !== 'auriculares') {
        await say(
          inbound,
          `Corte al interrumpirme: ${bargeLevel}. Uso: /conversacion corte off|altavoces|auriculares (vale desde la próxima sesión).`,
          { quote: true },
        );
        return;
      }
      bargeLevel = level;
      const hist = bargeStats.totals();
      const histRate = bargeFalseRate(hist);
      const histLine =
        hist.bargeIns >= 20
          ? ` Llevas ${hist.bargeIns} interrupciones: ${bargeClassified(hist)} clasificadas${histRate !== null ? ` (${Math.round(histRate * 100)}% falsas estimadas)` : ''}${hist.unclassified > 0 ? `, ${hist.unclassified} sin clasificar` : ''}. Es una estimación por transcripción, no una medición exacta.`
          : '';
      await say(
        inbound,
        (level === 'off'
          ? 'No me cortaré si hablas encima: te escucho cuando termine. Vale desde la próxima sesión.'
          : `Si hablas encima me callo (${level}). Con altavoces es aproximado y puede cortar de más o de menos; con auriculares es fiable. Vale desde la próxima sesión.`) +
          histLine,
        { quote: true },
      );
      return;
    }
    if (want !== 'on' && want !== 'off') {
      await say(inbound, 'Uso: /conversacion on|off|estado|corte', { quote: true });
      return;
    }
    if (want === 'off') {
      conversationOn = false;
      endSession('apagado');
      await say(
        inbound,
        'Conversación por voz apagada. La palabra de activación sigue como estaba.',
        { quote: true },
      );
      return;
    }
    if (!desktop) {
      await say(inbound, 'Sin micrófono en modo servidor.', { quote: true });
      return;
    }
    try {
      if (!currentWake()?.isRunning()) await startWake();
    } catch (err) {
      await say(
        inbound,
        `No he podido abrir el micrófono: ${err instanceof Error ? err.message : String(err)}`,
        { quote: true },
      );
      return;
    }
    conversationOn = true;
    await say(
      inbound,
      `Conversación por voz activada hasta el próximo reinicio. Di "${wakeWord}" y habla; se cierra tras 45 s en silencio, con "adiós"/"nada más" o con /conversacion off. Las confirmaciones y compras siguen pidiéndose aquí, nunca por voz.`,
      { quote: true },
    );
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
            (stats
              ? ` (ventanas oidas: ${stats.checks}, avisos: ${stats.wakeCount}` +
                `${stats.lastHeard ? `, lo ultimo que he oido: "${stats.lastHeard}"` : ''})`
              : '')
        : `Dejo de escuchar "${wakeWord}".`,
      { quote: true },
    );
  };

  await registry.startAll({
    // Un canal caido avisa una vez por caida y reintenta solo (antes: una linea
    // de log y canal muerto hasta reinicio, sin aviso — auditoria, linea 120).
    // El aviso va por el propio Telegram: si el fallo es de polling (conflicto
    // de getUpdates, el caso tipico) sendMessage sigue funcionando; si la red
    // esta caida, el catch lo traga y queda el log.
    onPollingLost: (_channel, message) => {
      void notifyLastChat(
        `He perdido la conexion con Telegram: ${message}. Reintento solo cada poco y te aviso al volver.`,
      ).catch(() => {});
    },
    onPollingRecovered: () => {
      void notifyLastChat('Telegram reconectado.').catch(() => {});
    },
    onMessage: async (inbound) => {
      if (!inbound.authorised) return;
      await withInboundFailureReply(
        async () => {
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

          // Disparador 'mensaje': texto normal (nunca un comando) cruza los
          // triggers del chat. No bloquea la respuesta al usuario.
          if (inbound.text && !inbound.text.startsWith('/')) {
            void triggerEngine
              .emit({ type: 'mensaje', scope: chatKey_, text: inbound.text })
              .catch((err) => {
                log.warn('trigger mensaje falló', { err: String(err) });
              });
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

          if (/^responde(?:r)? a ese\s*\n/i.test(inbound.text))
            return cmdCorreo(inbound, inbound.text);
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
                if (!desktop)
                  return say(inbound, DESKTOP_OFF_MESSAGE, { quote: true }).then(() => {});
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
              case 'cron': {
                const thread = await resolveThread(inbound);
                return cmdCron(thread, inbound, command.args);
              }
              case 'disparador':
              case 'trigger': {
                const thread = await resolveThread(inbound);
                return cmdTrigger(thread, inbound, command.args);
              }
              case 'disparadores':
              case 'triggers': {
                const chatKey_ = chatKey(inbound);
                return say(
                  inbound,
                  formatTriggerList(
                    store.listTriggers().filter((t) => inChatScope(t.scope, chatKey_)),
                  ),
                  { quote: true },
                );
              }
              case 'learn': {
                const thread = await resolveThread(inbound);
                return cmdLearn(thread, inbound, command.args);
              }
              case 'memory':
                return cmdMemory(inbound);
              case 'deshacer':
              case 'undo':
                return say(inbound, undoLast(), { quote: true }).then(() => {});
              case 'steer':
              case 'corrige':
                return cmdSteer(inbound, command.args);
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
              case 'evolucion':
                return cmdEvolucion(inbound, command.args);
              case 'estado':
                return cmdEstado(inbound);
              case 'vigila':
                return cmdVigila(inbound, command.args);
              case 'vigilando':
                return cmdVigilando(inbound);
              case 'dejar_de_vigilar':
                return cmdDejarDeVigilar(inbound, command.args);
              case 'precio':
                return cmdPrecio(inbound, command.args);
              case 'compara':
                return cmdCompara(inbound, command.args);
              case 'investiga':
                return cmdInvestiga(inbound, command.args);
              case 'resolver':
              case 'resolve':
                return cmdResolve(inbound, command.args);
              case 'buscar':
              case 'search': {
                const thread = await resolveThread(inbound);
                return cmdSearch(thread, inbound, command.args);
              }
              case 'memoria': {
                const thread = await resolveThread(inbound);
                return cmdMemoria(thread, inbound, command.args);
              }
              case 'exportar': {
                const thread = await resolveThread(inbound);
                return cmdExportar(thread, inbound, command.args);
              }
              case 'calendario':
                return cmdCalendario(inbound, command.args);
              case 'perfil': {
                return cmdPerfil(inbound, command.args);
              }
              case 'skills': {
                const sub = command.args.trim().split(/\s+/)[0]?.toLowerCase();
                if (sub === 'instalar' || sub === 'importar' || sub === 'install') {
                  return cmdSkillsImport(
                    inbound,
                    command.args.trim().split(/\s+/).slice(1).join(' '),
                  );
                }
                return say(inbound, 'Uso: /skills instalar <url de SKILL.md>', { quote: true });
              }
              case 'agenda':
                return cmdAgenda(inbound, command.args);
              case 'correo':
                return cmdCorreo(inbound, command.args);
              case 'ocr':
                return cmdOcr(inbound, command.args);
              case 'ojo':
                return cmdOjo(inbound, command.args);
              case 'permisos':
                return cmdPermisos(inbound, command.args);
              case 'ignora':
                return cmdIgnora(inbound, command.args);
              case 'ignorados':
                return cmdIgnorados(inbound, command.args);
              case 'avisos':
                return cmdAvisos(inbound, command.args);
              case 'voice':
                return cmdVoice(inbound, command.args);
              case 'conversacion':
                return cmdConversacion(inbound, command.args);
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
                await say(
                  inbound,
                  `No conozco el comando /${command.name}. /help para ver la lista.`,
                  {
                    quote: true,
                  },
                );
                return;
            }
          }

          const thread = await resolveThread(inbound);
          messageThread.set(dedupKey, thread.key);
          // "Dime más"/"sigue": sirve la respuesta completa cacheada sin gastar un turno.
          if (!inbound.images?.length && isMoreRequest(inbound.text)) {
            const full = takeFullReply(thread.key);
            if (full) {
              await say(inbound, full);
              return;
            }
          }
          // Serialise inside the thread only. Different threads run concurrently; the
          // machine mutex inside the tools is what keeps them from colliding.
          const gen = thread.generation;
          const next = thread.tail.then(async () => {
            if (thread.generation !== gen) return;
            await runTurn(thread, inbound, inbound.text, {});
          });
          thread.tail = next.catch(() => {});
        },
        (message) => say(inbound, message, { quote: true }),
        (error) => log.error('inbound message failed', { error: startupFailureMessage(error) }),
      );
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

  // El boton del mando tampoco es el camino critico: mismo trato que el
  // microfono. Si el 8765 esta ocupado, el daemon sigue sirviendo Telegram y
  // el boton simplemente no despertara a nadie hasta que se libere el puerto.
  await startTvButton();
  await startAlerts();

  control?.ready();
  log.info('daemon running', {
    wake: currentWake()?.isRunning() ?? false,
    wakeWord,
    tvButton: currentTvButton()?.port ?? null,
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
/**
 * Scope model: a thread's routines live at `chatKey#thread`, so a chat owns
 * exactly the scopes with that prefix — a bare startsWith(chatKey) would leak
 * telegram:123's routines into telegram:12 (auditor #135 ronda 2).
 */
export function inChatScope(scope: string, chatKey: string): boolean {
  return scope.startsWith(`${chatKey}#`);
}

/**
 * First free name in the scope, any kind: saveRoutine UPSERTS by (scope,name)
 * — steps and params included — so an implicit `/cron add` must never reuse an
 * existing name (auditor #135 ronda 2).
 */
export function uniqueRoutineName(store: Store, scope: string, base: string): string {
  if (!store.getRoutine(scope, base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!store.getRoutine(scope, candidate)) return candidate;
  }
}

export interface CronCommandDeps {
  store: Store;
  routineRunner: RoutineRunner;
  /** thread.key of the conversation the command runs in (`chatKey#thread`). */
  threadKey: string;
  /** chatKey without the `#thread` suffix. */
  chatKey: string;
}

/**
 * What the TV remote button does when pressed. It is an activation path of
 * its own — pressing a physical button IS the intent — so conversation mode
 * is NOT an input: /conversacion resets to off at every boot, and that used
 * to turn the button into a silent no-op (audit, "botón TV"). Without a chat
 * (nobody has talked yet) there is nowhere to open the session; without a
 * live wake listener there is no audio to feed it: the chat notice says so
 * instead of staying silent, and with no chat at all the log line is all
 * there is.
 */
export type TvButtonAction = 'open-session' | 'need-mic' | 'no-chat' | 'already-open';

export function tvButtonAction(opts: {
  hasChat: boolean;
  hasListener: boolean;
  sessionOpen: boolean;
}): TvButtonAction {
  if (!opts.hasChat) return 'no-chat';
  if (opts.sessionOpen) return 'already-open';
  if (!opts.hasListener) return 'need-mic';
  return 'open-session';
}

/**
 * The conversation an inspection command (/memory and friends) reads. Unlike
 * resolveThread it NEVER creates a thread — a read-only command has no
 * business spawning a conversation — and it never looks at occupancy: the
 * new-request heuristic ("main is busy, start #m<messageId>") is exactly what
 * made /memory answer "No recuerdo nada" with a full memory and litter a new
 * thread per read (auditor #152 ronda 1). Explicit intent wins, in
 * resolveThread's order: /topic, a reply to one of our messages, a real
 * Telegram thread id; without any of them, main is read even while busy.
 */
export function inspectionThreadKey(opts: {
  chatKey: string;
  activeTopic?: string | undefined;
  replyThreadKey?: string | undefined;
  /** Durable reply routing: a goal notification's owning scope, from SQLite. */
  replyGoalScope?: string | undefined;
  threadId?: string | undefined;
}): string {
  if (opts.activeTopic) return `${opts.chatKey}#${opts.activeTopic}`;
  if (opts.replyThreadKey) return opts.replyThreadKey;
  if (opts.replyGoalScope) {
    // Same validation as resolveThread: the notification must belong to THIS
    // chat — a foreign scope is ignored, never followed.
    const { chatKey, thread } = splitGoalScope(opts.replyGoalScope);
    if (chatKey === opts.chatKey) return `${chatKey}#${thread}`;
  }
  if (opts.threadId) return `${opts.chatKey}#t${opts.threadId}`;
  return `${opts.chatKey}#main`;
}

/**
 * The whole /memory reply, free of I/O so its canary runs against a real
 * MemoryStore without a daemon. The scope is thread.key — the same one the
 * turn context and the memory tool use (chatKey#thread). Any other scope
 * answers "No recuerdo nada" with a full memory, which is exactly the bug
 * the audit flagged.
 */
export function runMemoryCommand(memory: MemoryStore, scope: string): string {
  const entries = memory.all(scope);
  const scopes = memory.scopes();
  return entries.length
    ? [`Recuerdo ${entries.length} cosas:`, ...entries.map((e) => `- [${e.id}] ${e.text}`)].join(
        '\n',
      )
    : `No recuerdo nada todavía. Lo aprenderé sobre la marcha. (${scopes.length} conversaciones con memoria)`;
}

/**
 * The whole /cron command, free of I/O so its canaries run against a real
 * Store and RoutineRunner without a daemon (auditor #135 ronda 2). Returns
 * the exact reply text; the caller owns delivery.
 */
export function runCronCommand(deps: CronCommandDeps, args: string): string {
  const [subRaw, ...restParts] = args.trim().split(/\s+/).filter(Boolean);
  const sub = (subRaw ?? '').toLowerCase();
  const rest = restParts.join(' ');

  if (sub === 'del' || sub === 'borra' || sub === 'rm') {
    const name = rest.trim();
    if (!name) return 'Uso: /cron del <nombre>.';
    const routine =
      deps.store.getRoutine(deps.threadKey, name) ??
      deps.store.getRoutine(`${deps.chatKey}#main`, name);
    if (!routine || routine.kind !== 'schedule') {
      return `No tengo ninguna rutina programada llamada "${name}".`;
    }
    deps.store.deleteRoutine(routine.scope, routine.name);
    // Live without restart: the runner drops the timer on this sync. An
    // execution already in flight is NOT cancelled (the runner awaits its
    // in-flight set, it does not interrupt it), so the confirmation only
    // promises what it delivers (auditor #135 ronda 2).
    deps.routineRunner.sync();
    return `Rutina "${name}" borrada: no habrá nuevas ejecuciones. Si hay una en marcha ahora mismo, puede terminar y llegar su mensaje.`;
  }

  if (sub === 'pausa' || sub === 'pause' || sub === 'reanuda' || sub === 'reanudar') {
    const resuming = sub === 'reanuda' || sub === 'reanudar';
    const name = rest.trim();
    if (!name) return `Uso: /cron ${resuming ? 'reanudar' : 'pausa'} <nombre>.`;
    const routine =
      deps.store.getRoutine(deps.threadKey, name) ??
      deps.store.getRoutine(`${deps.chatKey}#main`, name);
    if (!routine || routine.kind !== 'schedule') {
      return `No tengo ninguna rutina programada llamada "${name}".`;
    }
    if (routine.enabled === resuming) {
      return resuming
        ? `La rutina "${name}" ya estaba activa.`
        : `La rutina "${name}" ya estaba en pausa.`;
    }
    deps.store.setRoutineEnabled(routine.scope, routine.name, resuming);
    deps.routineRunner.sync();
    if (!resuming) {
      return `Rutina "${name}" en pausa: no se ejecutará hasta que hagas /cron reanudar ${name}. Si hay una en marcha ahora mismo, puede terminar.`;
    }
    const live = deps.routineRunner
      .status()
      .find((st) => st.scope === routine.scope && st.name === routine.name);
    return `Rutina "${name}" reanudada. Próxima ejecución: ${nextRunLabel(routine.schedule, live?.next)}.`;
  }

  if (sub === 'probar' || sub === 'test' || sub === 'ahora') {
    const name = rest.trim();
    if (!name) return 'Uso: /cron probar <nombre>.';
    const routine =
      deps.store.getRoutine(deps.threadKey, name) ??
      deps.store.getRoutine(`${deps.chatKey}#main`, name);
    if (!routine || routine.kind !== 'schedule') {
      return `No tengo ninguna rutina programada llamada "${name}".`;
    }
    if (!routine.enabled) {
      return `La rutina "${name}" está en pausa. Reanúdala con /cron reanudar ${name} o dime si quieres probarla igualmente.`;
    }
    if (deps.routineRunner.isRunning(routine.scope, routine.name)) {
      return `La rutina "${name}" ya se está ejecutando ahora mismo.`;
    }
    // A test is a real run: same approvals, same tools, same purchase cap. Say so,
    // so nobody expects a dry run.
    void deps.routineRunner.fire(routine.scope, routine.name);
    return `Lanzo "${name}" ahora como prueba. Es una ejecución real (mismos permisos y aprobaciones que a su hora); el resultado llegará a este chat. Su horario no cambia.`;
  }

  if (sub === 'add') {
    if (!rest.trim()) {
      return 'Uso: /cron add 0 8 * * * | resumen del día — o en lenguaje natural: /cron add cada mañana a las 8 resumen del día.';
    }
    const parsed = parseCronAdd(rest, validateSchedule);
    if (!parsed.ok) return parsed.error;
    const base = routineNameFromPrompt(parsed.prompt);
    const name = uniqueRoutineName(deps.store, deps.threadKey, base);
    const created = deps.store.saveRoutine({
      scope: deps.threadKey,
      name,
      kind: 'schedule',
      prompt: parsed.prompt,
      schedule: parsed.schedule,
    });
    // Live at once, igual que /routine: una rutina que solo dispara tras
    // reiniciar es una que el usuario tiene que recordar que pidió.
    deps.routineRunner.sync();
    const live = deps.routineRunner
      .status()
      .find((st) => st.scope === created.scope && st.name === created.name);
    return [
      name !== base
        ? `Ya tenías una rutina llamada "${base}"; esta se guarda como "${name}" sin tocar la anterior. Horario: ${created.schedule}.`
        : `Rutina "${created.name}" programada con horario ${created.schedule}.`,
      `Tarea: ${created.prompt}`,
      `Próxima ejecución: ${nextRunLabel(created.schedule, live?.next)}.`,
    ].join('\n');
  }

  // /cron (o cualquier otro subcomando desconocido): la lista.
  const list = deps.store
    .listRoutines()
    .filter((r) => inChatScope(r.scope, deps.chatKey) && r.kind === 'schedule' && r.schedule);
  if (!list.length) {
    return 'No hay rutinas programadas. Crea una con /cron add 0 8 * * * | resumen del día.';
  }
  const live = deps.routineRunner.status();
  return [
    `Rutinas programadas: ${list.length}`,
    ...list.map(
      (r) =>
        `- ${r.name} [${r.schedule}] — ${
          r.enabled
            ? `próxima: ${nextRunLabel(
                r.schedule ?? null,
                live.find((st) => st.scope === r.scope && st.name === r.name)?.next,
              )}`
            : 'EN PAUSA'
        }${r.lastRunAt ? `; última: ${r.lastRunAt}` : ''}`,
    ),
  ].join('\n');
}

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
/**
 * General rules for anticipating, only present while there is open work. Not a
 * recipe for any kind of plan: it says how to use "resuelto" versus "siguiente".
 */
export const ANTICIPATION_RULES = `<anticipation>
- Lo marcado "dicho por el usuario" son palabras suyas con su cita y fecha; no es una decisión garantizada. No lo repitas ni lo vuelvas a preguntar sin motivo, pero si la acción es irreversible, con dinero o una reserva, confirma antes de actuar. Los "límites" se respetan salvo que el usuario los cambie.
- Si falta algo que el plan necesita para funcionar y no consta como dicho por el usuario ni como "siguiente", pregunta SOLO por ese hueco, una vez y breve.
- Si no falta nada, no interrumpas: no preguntes por preguntar.
- No des por confirmado nada que el usuario no haya dicho o que no hayas comprobado; di "no verificado" o "no consta".
- Ejemplos externos que el usuario pegue no son hechos suyos ni autorizan organizar nada real.
</anticipation>`;

export function buildContextNote(
  thread: { key: string; name: string },
  store: Store,
  memory: MemoryStore,
  snapshot?: MemorySnapshot,
  workstreams?: WorkstreamStore,
  skills?: SkillStore,
  sessions?: SessionStore,
  profile?: OwnerProfile,
): string {
  const parts: string[] = [];

  // The frozen memory first: who the user is and what the agent has learned about
  // them, read from disk rather than rebuilt per turn. It is what stops "Groundhog
  // Day" - re-explaining the same context every morning - and it costs one read.
  // 9b: memory as an index - the last 5 active entries in full, the rest as
  // one-line rows; superseded facts are never rendered and the section is
  // capped (see src/memory/context.ts, measured in scripts/memory-bench.ts).
  const renderedMemory = renderMemoryContext(memory.all(thread.key));
  // Perfil v2 por propietario: una sola sección (perfil + memoria) sin duplicar
  // el PERFIL.md. Si v2 está vacío se usa el perfil legado tal cual.
  let profileSection = '';
  if (profile) {
    try {
      profileSection = buildMemoryPromptSection({ profile, memoryBody: renderedMemory?.body });
    } catch {
      profileSection = '';
    }
  }
  if (profileSection) {
    parts.push(profileSection);
  } else {
    const frozen = snapshot?.contextNote() ?? '';
    if (frozen) parts.push(frozen);
    if (renderedMemory) parts.push(`<memory>\n${renderedMemory.body}\n</memory>`);
  }
  // Continuidad entre reinicios y cambios de tema: lo último que se habló en este
  // chat, una línea por sesión. Es un resumen, no la transcripción, y va aparte de
  // la memoria curada: sirve para "¿cómo quedamos ayer?" sin releer nada.
  if (sessions) {
    try {
      const recent = sessions
        .recent(thread.key, 4)
        .filter((s) => (s.summary ?? '').trim().length > 0);
      if (recent.length) {
        parts.push(
          `<historial>\n${recent
            .map((s) => {
              const when = new Date(s.startedAt).toLocaleDateString('es-ES', {
                day: 'numeric',
                month: 'short',
              });
              // Title and summary are stored text (the summary is a past agent
              // reply): they render inside <historial>, so markup characters go.
              const title = plainInline(s.title).replace(/\s+/g, ' ').trim();
              const summary = plainInline(s.summary ?? '')
                .replace(/\s+/g, ' ')
                .slice(0, 200);
              return `- ${when} · ${title}: ${summary}`;
            })
            .join('\n')}\n</historial>`,
        );
      }
    } catch (err) {
      log.warn('recent sessions failed', { err: String(err) });
    }
  }
  const routines = store.listRoutines(thread.key).filter((r) => r.enabled);
  if (routines.length) {
    parts.push(
      `<routines>\n${routines
        .map(
          (r) =>
            `- ${plainInline(r.name).replace(/\s+/g, ' ').trim()} (${r.kind})${r.schedule ? ` [${r.schedule}]` : ''}`,
        )
        .join('\n')}\n</routines>`,
    );
  }
  // Open fronts of work, as the compact index the store writes for prompts.
  // Include paused fronts too: a pending decision must not disappear. A standing
  // "nothing open" line would pay tokens on every turn to say nothing.
  const ws = workstreams?.index(thread.key) ?? '';
  if (ws && ws !== 'Sin frentes de trabajo abiertos.') {
    parts.push(`<workstreams>\n${ws}\n</workstreams>\n${ANTICIPATION_RULES}`);
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
 * A short, human-readable description of one tool call, for the action log.
 *
 * Deliberately coarse. The log is a record of *what happened*, and the argument list
 * of a tool call is the single most dangerous thing to write into a plaintext file:
 * a shell command can carry a token, `mail send` carries a recipient, `fill` carries
 * whatever the user is typing into a password box. Everything that reaches this log
 * goes through `redact`, and the summary is capped, so a line in the log can be read
 * aloud over Telegram without thinking about it first.
 *
 * The tool name alone is not enough ("browser, browser, browser"), so the last
 * summary the agent reported is used as the detail when there is one.
 */
function summarizeToolUse(summary: string): string {
  const detail = summary.replace(/\s+/g, ' ').slice(0, 120).trim();
  // `redact` blanks any value that looks like a secret whatever the key is called,
  // so passing the summary under a neutral key still gets it scrubbed.
  return redact({ detail }).detail as string;
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
 *
 * Las rutas se comparan RESUELTAS (realpath): con `npm link`, `pnpm link` o
 * cualquier instalacion por symlink/junction, argv[1] trae la ruta del link
 * (node_modules\personal-agent\...) mientras que import.meta.url trae la ruta
 * real del repo. Sin realpath la comparacion falla, isEntrypoint devuelve false
 * y el CLI sale con codigo 0 sin hacer NADA (silencioso). Ver tests/entrypoint.
 */
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const resolveReal = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const entryUrl = pathToFileURL(resolveReal(entry)).href;
  const selfUrl = pathToFileURL(resolveReal(fileURLToPath(import.meta.url))).href;
  // Windows paths are case-insensitive and the drive letter's case depends on how
  // the process was launched, so an exact URL match alone would miss its own entry.
  return selfUrl === entryUrl || selfUrl.toLowerCase() === entryUrl.toLowerCase();
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
