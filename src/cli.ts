// FIRST import, always: loads the optional .env before any module that
// captures process.env at evaluation time (paths.ts, log.ts). See envfile.ts.

import { resolveModelCaps } from './core/models.js';
import { ERASE_PROMPT, EraseConfirm, eraseChat, eraseSummary } from './erase-command.js';
import {
  formatModelos,
  ModelChoiceStore,
  modelSwitchWarnings,
  parseModelo,
} from './model-choice.js';
import { cleanProjectPath, ProjectContextStore } from './project-context.js';
import { formatTokens, LastTurns, rewindLastTurn } from './retry-turn.js';
import { foldAccents } from './text.js';
import { startWebhookServer, webhookConfig } from './webhook.js';
import './envfile.js';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { loadCalendar } from './agenda/ics.js';
import { readAgendaOverview } from './agenda/overview.js';
import { readLocalCalendar } from './agenda/sources.js';
import { buildAgenda, calendarDaysFor } from './agenda/unified.js';
import { estimateDueAt, hasDateSignal } from './alerts/due.js';
import { FollowupTracker, ownerDmFollowups, ownerDmKeyFor } from './alerts/followups.js';
import {
  altavozVoiceReplyEnabled,
  routeInboundToAltavoz,
  routeReplyToAltavoz,
} from './audio/altavoz-inbound.js';
import { ActionLog } from './audit/log.js';
import { isBackupDue, runBackup } from './backup.js';
import { KINDLE_VAULT_KEY } from './books/kindle.js';
import { BOOT_NOTICE_FILE, bootBanner, maybeSendBootNotice } from './boot-notice.js';
import { BrowserService } from './browser/service.js';
import { EMAIL_CHANNEL, emailAuditRecord, taintEmailTurn } from './channels/email.js';
import { setupEmailChannel } from './channels/email-setup.js';
import {
  cleanForTelegram,
  friendlyError,
  isAgendaTitle,
  isCronTitle,
  isReminderTitle,
  isStatusTitle,
  isWatchListTitle,
  marksCardTitle,
  marksWithTitles,
  progressNote,
  shorten,
  stripVoicePrefix,
} from './channels/formatters.js';
import { QaChannel } from './channels/qa.js';
import { ChannelRegistry } from './channels/registry.js';
import { TelegramChannel } from './channels/telegram.js';
import {
  InboundReceipt,
  LiveNote,
  RECEIPT_READ_TEXT,
  receiptKind,
  receiptStartText,
  voiceHeardText,
} from './channels/telegram-receipts.js';
import type { ChannelAudio, Inbound, Outbound } from './channels/types.js';
import { chatIdOf, chatKey, chatNumberOf, parseChatKey } from './channels/types.js';
import { type Config, loadConfig } from './config.js';
import { type ControlStartup, controlledDaemon } from './controlled-daemon.js';
import type { AgentRunResult } from './core/agent.js';
import { PersonalAgent } from './core/agent.js';
import { attentionFreeConfig, createAttentionJudge } from './core/attention-model.js';
import { dedupeNewFacts } from './core/history.js';
import { createProviderHandle } from './core/provider.js';
import { createDelegateWiring } from './core/subagent-wiring.js';
import { baseTools, MACHINE_TOOLS } from './core/tool-registry.js';
import { parseNatural } from './cron/scheduler.js';
import { buildCommandTable, dispatchCommand } from './daemon/commands.js';
import { createGoalNotifySend } from './daemon/goal-notify.js';
import { createGoalTickExecute } from './daemon/goal-tick.js';
import {
  beginInbound,
  cachedFullReply,
  queueThreadTurn,
  resolveInboundThread,
  routeInboundControl,
  threadForSentIds,
} from './daemon/inbound.js';
import { runPanelChat, type TurnOutput } from './daemon/panel-chat.js';
import { createPurchaseApprovals } from './daemon/purchase-approvals.js';
import { chatIdOfScope, createRoutineFire, deliverMissedThenStart } from './daemon/routine-fire.js';
import { createRoutineTask } from './daemon/routine-task.js';
import { ThreadOutputs, threadContext } from './daemon/thread-context.js';
import { voiceUtteranceTurn } from './daemon/voice-turn.js';
import { applyConfiguredTimeZone, localDay, localTimeZone } from './datecontext.js';
import { Store } from './db.js';
import { addHypothesis, describeLast, isEvolveDue, runEvolution } from './evolve/run.js';
import { createFactorySync } from './factory/loader.js';
import { PlaybookStore } from './gestor/playbooks.js';
import { effectOverrideReason, GestorStore } from './gestor/store.js';
import { GoalNotifier, NOTIFY_FLUSH_INTERVAL_MS } from './goals/notify.js';
import { GoalRunner } from './goals/runner.js';
import { GoalStore, splitGoalScope } from './goals/store.js';
import { LearnRecorder } from './learn.js';
import { assertNotRunning, installLifecycle } from './lifecycle.js';
import { llmHealthCommand, providerKeySource } from './llm-health.js';
import { log, redact } from './log.js';
import { loadAccount as loadMailAccount, searchMail, sendMail } from './mail/client.js';
import { pollGmailCommandMail } from './mail/command-inbox.js';
import { type IdleCursor, loadReadMailAccount, MailIdleTransport } from './mail/idle.js';
import { listReplyInbox, resolveReplyCard } from './mail/reader.js';
import { loadSendMailAccount, replyOnOwnerRequest } from './mail/reply.js';
import { mailStatus } from './mail/status.js';
import { findCurlImpersonate } from './media/download.js';
import { AudioRecall } from './media/recall.js';
import { isConsolidationDue, runConsolidation } from './memory/consolidate.js';
import { DecisionLedger } from './memory/decisions.js';
import { canExtract, DocMemory } from './memory/docs.js';
import { imageExtension, imageNote, ocrImageBytes } from './memory/images.js';
import { InstinctStore } from './memory/instincts.js';
import {
  correctionHint,
  forgetLearnedRule,
  formatLearnedRules,
  learnCorrectionsEnabled,
  learnedRules,
  learnedRulesCommand,
  learnFromTurn,
} from './memory/learned-rules.js';
import { detectMemoryWorthy } from './memory/nudges.js';
import { contradictionsReply } from './memory/review.js';
import { semanticFromEnv } from './memory/semantic.js';
import { SessionStore } from './memory/sessions.js';
import { MemorySnapshot } from './memory/snapshot.js';
import { NudgeTracker } from './memory/usermodel.js';
import { WorkstreamStore } from './memory/workstreams.js';
import { looksLikeCredential, MemoryStore, memoryScopesFor, panelMemoryEntries } from './memory.js';
import { parseOcrMode, runOcrJob } from './ocrdoc/job.js';
import { OcrFolderWatcher, watchModeFromEnv } from './ocrdoc/watcher.js';
import { windowsDeps } from './ocrdoc/windows.js';
import { trackBusyIn } from './ocupada.js';
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
import { Gate, runPermisosCommand } from './permissions.js';
import { deepResearch, renderReport } from './research/deep-research.js';
import {
  parseWideArgs,
  renderWideReport,
  WIDE_MAX_ITEMS,
  wideCsvAttachment,
  wideResearch,
  wideResearchEnabled,
} from './research/wide-research.js';
import { drainThreadTails } from './shutdown-drain.js';
import { skillsCatalogReply } from './skills/catalog.js';
import { refineFromLessons } from './skills/refine.js';
import { fetchSkillIndex, formatSkillSearch, searchSkillIndex } from './skills/search.js';
import { checkTelegramToken, startupFailureMessage, withInboundFailureReply } from './startup.js';
import { WebDemoRecorder } from './teach-demo-web.js';
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
/**
 * Tool `delegate` (multi-agente). El hijo solo recibe herramientas de lectura del
 * padre, con Gate propia sin approver: ver core/subagent-wiring.ts. Un pool por
 * proceso para que los limites de concurrencia valgan para todos los hilos.
 */
let delegateWiring: ReturnType<typeof createDelegateWiring> | undefined;
function delegateTool(config: Config): AgentTool {
  delegateWiring ??= createDelegateWiring({
    config,
    protectedPaths: protectedPaths(),
    secretPaths: secretStatePaths(),
    parentTools: () => [...fsTools, createFetchTool(), createWebTool(config)] as AgentTool[],
  });
  return delegateWiring.tool;
}

import { appendEvent } from './agenda/write.js';
import { type AlertInbox, startAlertInbox } from './alerts/inbox.js';
import { approvals } from './approvals/broker.js';
import {
  ALTAVOZ_USAGE,
  AltavozStore,
  altavozStatusText,
  createAltavozPlayer,
  parseAltavozArgs,
  stopReplyText,
} from './audio/altavoz.js';
import { audioTeleEnabled, tvCasterFromVault, tvStopperFromVault } from './audio/tv-cast.js';
import { verifyCallAudit } from './audit/calls.js';
import { SecretLibrary } from './books/secret.js';
import {
  agendaTodayLines,
  answerBriefingOnDemand,
  briefingSpeaker,
  type DailyBriefingDeps,
  fetchWeatherLine,
  followupsDue,
  pickImportantMail,
  scheduledForToday,
  startDailyBriefingTimer,
  stopBriefingVoice,
  weatherConfigFromEnv,
} from './briefing-daily.js';
import { permisosListaReply } from './channels/permisos-lista.js';
import {
  cacheFullReply,
  commandButton,
  isMoreRequest,
  moreButton,
  takeFullReply,
  tooBigForBotDownload,
} from './channels/telegram.js';
import { helpText, startText } from './channels/telegram-help.js';
import {
  CommandRoutineStore,
  commandRoutinesEnabled,
  fireCommandRoutine,
  isCommandRoutine,
} from './command-routine.js';
import { dailyBudgetExceeded, recordUsage, usageReport } from './core/usage.js';
import { formatUsageReport, parseUsageDays } from './core/usage-format.js';
import {
  FUNCIONES_CALLBACK_PREFIX,
  findArea,
  funcionesButtons,
  funcionesButtonText,
  funcionesText,
} from './funciones.js';
import { parseMcpServers } from './mcp/client.js';
import { mcpHttpDoctorLines, mcpHttpEnabled, parseMcpHttpServers } from './mcp/http-client.js';
import { createMcpTools, mcpCommandText, mcpResourcesDoctorLines } from './mcp/tools.js';
import { OwnerProfile } from './memory/profile.js';
import {
  currentLimits,
  getPace,
  paceText,
  parsePace,
  recordDismissal,
  setPace,
} from './notice-pace.js';
import { panelDoctorLines } from './panel-doctor.js';
import { DESKTOP_OFF_MESSAGE, desktopEnabled, toolsForMode } from './platform.js';
import { computerPlugin } from './plugins/computer.js';
import { iphonePlugin } from './plugins/iphone.js';
import { ocrLocalPlugin } from './plugins/ocr.js';
import { tvPlugin, tvToolDeps } from './plugins/tv.js';
import { RoutineDeliveryStore } from './routine-delivery.js';
import {
  buildMacroPrompt,
  canonicalMacroName,
  detectMacroParams,
  isMacroName,
  parseMacroArgs,
  procedurePrompt,
  RoutineRunner,
  summarizeRoutine,
} from './routines.js';
import {
  applySavedComputerOff,
  computerOffSaved,
  computerSwitchCommand,
  saveComputerSwitch,
} from './screen/computer-switch.js';
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
import { formatServicesList, ServiceStore } from './services/store.js';
import { seedBuiltinSkills } from './skills/builtin.js';
import { fetchSkillMarkdown, installSkill } from './skills/import.js';
import { recordLessons } from './skills/lessons.js';
import { SkillStore } from './skills/store.js';
import { conversationStatus, formatStatus, summarizeLog } from './status.js';
import { steerChat } from './steer.js';
import { createAgendaTool } from './tools/agenda.js';
import { createBookTool } from './tools/book.js';
import { createBrowserTool } from './tools/browser.js';
import { createCalendarTool } from './tools/calendar.js';
import { createCheckoutPage, createCheckoutTool } from './tools/checkout.js';
import type { ActionGate } from './tools/computer.js';
import { createDecisionTool } from './tools/decision.js';
import { createDocsTool } from './tools/docs.js';
import { createAskTool, createDoneTool } from './tools/done.js';
import { createDownloadTool } from './tools/download.js';
import { createFactoryTool } from './tools/factory.js';
import { createFetchTool, fetchPage, isFetchableResolved } from './tools/fetch.js';
import { fsTools } from './tools/fs.js';
import { createGestionTool } from './tools/gestion.js';
import { createGoalTool } from './tools/goal.js';
import { createMediaTool } from './tools/media.js';
import { createMemoryTool } from './tools/memory.js';
import { createOcrTool } from './tools/ocr.js';
import { createOpenGymTool, type GymKind, gymAnswer } from './tools/opengym.js';
import { createPriceWatchTool } from './tools/price-watch.js';
import {
  createReminderTool,
  FiredReminders,
  formatReminderRows,
  pickReminder,
  readDroppedReminders,
  reminderButtonCommand,
  reminderRows,
  reminderText,
} from './tools/reminder.js';
import { createServiceTool } from './tools/service.js';
// Renfe stays unregistered on purpose: a tool that only knows one site lets the agent
// report a booking it never made, which is the exact failure this project exists to
// remove. The generic browser does the same job against any site.
import { createShellTool } from './tools/shell.js';
import { sandboxDoctorLines } from './tools/shell-sandbox.js';
import { createSkillsTool } from './tools/skills.js';
import { createSystemTool, playAudioFile, playbackRestoreText } from './tools/system.js';
import { createTvTool } from './tools/tv.js';
import { buildWebBackends, createWebTool } from './tools/web.js';
import { createWindowsTool, listWindows } from './tools/windows.js';
import { startTvButtonListener, type TvButtonListener } from './tv/button-listener.js';
import { tvRequest } from './tv/lgtv.js';
import { staleTvOrderNotice } from './tv/stale-order.js';
import {
  createTvPressGuard,
  TV_BUTTONS_TITLE,
  tvButtonCommand,
  tvButtons,
  tvChatCommand,
} from './tv/tv-chat-command.js';
import { setUndoDir, undoLast } from './undo.js';
import { Mutex } from './utils.js';
import {
  initVault,
  unlock,
  vaultDelete,
  vaultExists,
  vaultGet,
  vaultList,
  vaultSet,
  vaultSnapshotValues,
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
import { createDefaultTts } from './voice/piper.js';
import { createMciSpeaker, type Playback } from './voice/speaker.js';
import { SpeakerVerifier, speakerGateConfigFromEnv } from './voice/speaker-verify.js';
import { stopSpokenReply } from './voice/stop-speech.js';
import { transcribeVoiceNote } from './voice/stt.js';
import { REPLY_TTS_BUDGET_MS, speakWithin } from './voice/tts.js';
import { speakerProfilesFile } from './voice/voice-cli.js';
import { defaultTranscriber, stripWakeWord, WakeWordListener } from './voice/wake.js';
import {
  COMPARE_WATCH_STALE,
  type CompareReport,
  CompareWatchLinks,
  compareProduct,
  describeCompare,
  suggestedTargetCents,
} from './watch/compare.js';
import { forChat, formatOverview, isOverviewTitle, type OverviewEntry } from './watch/overview.js';
import {
  type CheckOutcome,
  describeChange,
  describeWatch,
  eur,
  PAGE_MUTE_MS,
  type PageWatch,
  PageWatchStore,
  parseVigilaArgs,
} from './watch/pages.js';
import {
  PRICE_MUTE_MS,
  type PriceNotifyOpts,
  PriceStore,
  parseConfig as parsePricewatchConfig,
} from './watch/pricewatch.js';
import { startPricewatchLoop } from './watch/pricewatch-loop.js';
import { realDeps } from './watch/pricewatch-runner.js';
import { WebRouter } from './web/router.js';
import { createOwnerGoalsReader } from './webui/goals.js';
import { panelNextUp, panelRoutines } from './webui/next-up.js';
import { parseAllowedHosts, startWebUi } from './webui/server.js';
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
  pa vigilancias [--json] qué está vigilando: páginas, precios, rutinas y disparadores (solo lectura)
  pa tv setup <ip>        emparejar la LG webOS (acepta el aviso en la tele, una vez)
  pa tv toast <mensaje>   mostrar un aviso en la tele
  pa tv apps              listar apps instaladas (ids para pa tv launch)
  pa tv launch <appId>    lanzar una app en la tele
  pa tv key <NOMBRE>      pulsar una tecla del mando (HOME, BACK, ENTER, UP/DOWN/LEFT/RIGHT)
  pa tv shot [fichero]    capturar la pantalla de la tele (960x540 jpg; DRM sale en negro)
  pa tv off               apagar la tele
  pa audio prueba-tele <fichero.mp3> [--via media.viewer|launcher|glasshouse]  probar que un audio suena en la tele
  pa voice enroll|verify|list|remove  voces del hogar: enrolar, puntuar un audio, listar, borrar
  pa opengym pair [url] <code>   pair openGym (read-only gym tracker)
  pa opengym status       check the openGym connection
  pa evolve [--idea <text>]  one self-improvement cycle on this git checkout (needs PA_EVOLVE_PROPOSER)
  pa autostart install|status|uninstall [--start] [--what-if] [--no-local-llm]
  pa autoupdate status|now|off|on   se actualiza sola desde main (PA_AUTOUPDATE=0 la apaga)
  pa status [--json]      estado puntual del PID y latido, sin cambiar el daemon
  pa watchdog --status [--json]  consulta puntual; no instala ni activa vigilancia
  pa precio [comprobar]          un ciclo del vigilante de precios ahora (avisos por pantalla) o valida pricewatch.json
  pa diagnose [--json]    diagnóstico local del daemon, sin arrancarlo ni reiniciarlo
  pa stop                 Linux: cierre graceful autenticado, sin matar por PID
  pa restart              no disponible sin verificar supervisor
  pa doctor               check the environment
  pa backup [lista]       copias de seguridad; pa backup restaurar <AAAA-MM-DD|ultima> con el daemon parado
  pa auditoria [--tool <n>] [--verdict allow|deny] [--since 24h|7d] [--last N] [--json]  registro de llamadas (solo lectura)
  pa mcp serve            servidor MCP de solo lectura por stdio (Claude Desktop, Cursor)
  pa iniciar [--solo-comprobar] [--sin-red] [--json]  comprueba todo (verde/rojo) y arranca si está listo
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
import { buildContextNote } from './daemon/context-note.js';
import {
  commandRoutineTag,
  inChatScope,
  nextRunLabel,
  routineNameFromPrompt,
  runCronCommand,
  scheduledAgendaText,
} from './daemon/cron-command.js';
import {
  approvalsDbPath,
  createDaemonGate,
  protectedPaths,
  secretStatePaths,
} from './daemon/gate.js';
import { formatSessionHits } from './daemon/session-hits.js';
import { trimForSpeech } from './daemon/speech-text.js';
import { summarizeTranscript } from './daemon/transcript-summary.js';
import { retentionIfDue } from './maintenance.js';
import { tvCommand } from './tv/tv-cli.js';

export { ANTICIPATION_RULES, buildContextNote } from './daemon/context-note.js';
export {
  type CronCommandDeps,
  commandRoutineTag,
  formatNextRun,
  inChatScope,
  nextRunLabel,
  routineNameFromPrompt,
  runCronCommand,
  scheduledAgendaText,
  uniqueRoutineName,
} from './daemon/cron-command.js';
export { approvalsDbPath, createDaemonGate, type DaemonGateOptions } from './daemon/gate.js';
export { formatSessionHits } from './daemon/session-hits.js';
export { trimForSpeech } from './daemon/speech-text.js';
export { summarizeTranscript } from './daemon/transcript-summary.js';

/** Re-emparejado de la tele durante un cast de audio: misma clave que usa la tool `tv`. */
const saveTvClientKey = (key: string): Promise<void> => vaultSet('tv:clientKey', key);

export async function main(argv: string[]): Promise<number> {
  const [command = 'chat', ...rest] = argv;
  // Todos los subcomandos (no solo `serve`) leen la hora en la zona de PA_TIMEZONE:
  // `pa recordatorios`, `pa precio`… calculaban «hoy» y las próximas horas de croner en
  // la zona del sistema. `serve` vuelve a llamarlo y avisa si la zona no es válida.
  applyConfiguredTimeZone();

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
    case 'audio': {
      const { audioCommand } = await import('./audio/prueba-tele.js');
      return audioCommand(rest, {
        copyToTemp: async (file) => {
          const out = join(tmpdir(), `pa-prueba-tele-${process.pid}-${Date.now()}.mp3`);
          copyFileSync(file, out);
          return out;
        },
        cast: (file, only) =>
          tvCasterFromVault(vaultGet, tvRequest, { only, saveClientKey: saveTvClientKey })(file),
        print: (line) => console.log(line),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        discard: (file) => rmSync(file, { force: true }),
      });
    }
    case 'tv':
      return tvCommand(rest, {
        runOrder: async (text) => {
          const res = await createTvTool(tvToolDeps(new Store())).execute('tv-cli', {
            action: 'command',
            text,
          });
          return res.content
            .map((c) => (c.type === 'text' ? c.text : ''))
            .join(' ')
            .trim();
        },
      });
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
    case 'autoupdate': {
      const { autostartRepo } = await import('./autostart.js');
      const { autoupdateCommand } = await import('./autoupdate-cli.js');
      return autoupdateCommand(rest, { stateDir: paths.state, repo: autostartRepo() });
    }
    case 'autostart-notify': {
      const { notifyAutostart } = await import('./autostart.js');
      return rest.length === 1 ? notifyAutostart(rest[0] ?? '') : 2;
    }
    case 'precio': {
      const { pricewatchCommand } = await import('./watch/pricewatch-cli.js');
      return pricewatchCommand(rest);
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
    case 'vigilancias': {
      const { vigilanciasCommand } = await import('./watch/overview-cli.js');
      return vigilanciasCommand(rest);
    }
    case 'backup': {
      const { backupCommand } = await import('./backup-restore.js');
      return backupCommand(rest);
    }
    case 'auditoria': {
      const { auditCommand } = await import('./audit/audit-cli.js');
      return auditCommand(rest);
    }
    case 'mcp': {
      const { mcpCommand } = await import('./mcp/serve-cli.js');
      return mcpCommand(rest);
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
    case 'iniciar': {
      const { iniciarCommand, realPreflightDeps } = await import('./iniciar.js');
      const { STARTUP_RECORD_FILE } = await import('./startup-record.js');
      if (!rest.some((a) => ['--solo-comprobar', '--check', '--json'].includes(a))) {
        const { clearStoppedOnPurpose } = await import('./autostart-watchdog.js');
        clearStoppedOnPurpose(paths.state);
      }
      return iniciarCommand(rest, {
        deps: realPreflightDeps,
        serve: () => controlledDaemon(serveCommand),
        write: (text) => process.stdout.write(text),
        writeErr: (text) => process.stderr.write(text),
        color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
        recordPath: join(paths.state, STARTUP_RECORD_FILE),
      });
    }
    case 'stop': {
      if (rest.length) {
        process.stderr.write('uso: pa stop\n');
        return 2;
      }
      const { stopDaemon } = await import('./daemon-control.js');
      const { markStoppedOnPurpose } = await import('./autostart-watchdog.js');
      const { runStopCommand } = await import('./stop-command.js');
      return runStopCommand({
        stop: () => stopDaemon(paths.state),
        markStopped: () => markStoppedOnPurpose(paths.state),
        write: (text) => process.stdout.write(text),
        writeErr: (text) => process.stderr.write(text),
      });
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

  const keySrc = await providerKeySource(loadConfig().baseUrl);
  lines.push(
    `provider key    ${keySrc.source === 'unset' ? `unset (${keySrc.hint})` : keySrc.source}`,
  );
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

  lines.push(...(await sandboxDoctorLines()));
  lines.push(...panelDoctorLines());
  lines.push(...(await mcpHttpDoctorLines()));
  lines.push(...mcpResourcesDoctorLines());

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
 * The vertical slice: one agent, console input, gate armed, tools registered.
 * Everything else (channels, scheduler) plugs in behind this same shape.
 */
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
    allow: ['read', 'list', 'fetch', 'done', 'delegate'],
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
  const tools = baseTools({
    config,
    screen,
    computerGate: (call) => gate.check(sessionId, { ...call, actor: 'asistenta' }),
    delegate: delegateTool(config),
    onFactoryChange: () => void factorySyncLocal(),
  });

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
    allow: ['read', 'list', 'fetch', 'done', 'delegate'],
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
  const tools = baseTools({
    config,
    screen,
    computerGate: (call) => gate.check(sessionId, { ...call, actor: 'asistenta' }),
    delegate: delegateTool(config),
    onFactoryChange: () => void factorySyncRun(),
  });

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
  const t = foldAccents(text);
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
  const projectContexts = new ProjectContextStore(join(paths.state, 'proyectos.json'));
  const lastTurns = new LastTurns<unknown, NonNullable<Inbound['images']>[number]>();
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
  // Skills de ingeniería incluidas (diagnosticar bugs, TDD): solo las que falten.
  seedBuiltinSkills(skills);
  const playbooks = new PlaybookStore({ dir: join(paths.state, 'playbooks') });
  const adoptedServices = new ServiceStore({ dir: join(paths.state, 'services') });
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
  // F10: correo como canal (apagado salvo PA_CORREO_CANAL=1; solo remitentes de la lista con dkim=pass).
  const emailSetup = await setupEmailChannel({
    stateDir: paths.state,
    loadRead: () => loadReadMailAccount(),
    loadSend: () => loadSendMailAccount(),
    send: (account, req) => sendMail(account, req),
    poll: (account, cursorFile) => pollGmailCommandMail(account, cursorFile),
    audit: (e) => {
      if (e.accepted) {
        log.info('correo canal: aceptado', e);
        return;
      }
      log.warn('correo canal: ignorado', e);
      actions.record(emailAuditRecord(e));
    },
  });
  if (emailSetup.channel) registry.register(emailSetup.channel);
  else if (process.env.PA_CORREO_CANAL === '1')
    log.warn('correo canal sin arrancar', { reason: emailSetup.reason });

  const screen = new WindowsScreen();
  const tts = createDefaultTts(process.env, {
    onFallback: (err) => log.warn('tts fallback', { err }),
  });

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
  // Modo altavoz (/altavoz pc|tele|off): las notas de voz del dueño suenan solas al
  // llegar, en serie y sin tocar el volumen del sistema (docs/audio-altavoz.md).
  const altavoz = new AltavozStore(join(paths.state, 'altavoz.json'));
  // F7: /modelo por conversación, guardado para que sobreviva a un reinicio.
  const modelChoices = new ModelChoiceStore(join(paths.state, 'modelos.json'));
  // /ordenador off guardado: el PC sigue sin control tras reiniciar (solo más estricto;
  // PA_COMPUTER_USE=0 en el .env manda siempre).
  if (applySavedComputerOff(config, paths.state)) {
    log.warn(
      'Computer Use arranca desactivado: /ordenador off guardado (usa /ordenador on para activarlo)',
    );
  }
  const altavozPlayer = createAltavozPlayer({
    toPlayable: (bytes, mimeType) => toPlayableAudio(bytes, mimeType),
    playOnPc: async (file, signal) => {
      currentWake()?.suppress(PLAYBACK_SUPPRESS_MS);
      try {
        const playback = createMciSpeaker().play(file);
        signal?.addEventListener('abort', () => playback.stop(), { once: true });
        await playback.done;
      } finally {
        currentWake()?.suppress(WAKE_TAIL_MS);
      }
    },
    castToTv: audioTeleEnabled()
      ? tvCasterFromVault(vaultGet, tvRequest, { saveClientKey: saveTvClientKey })
      : undefined,
    // /stop también para en la tele una nota mandada hace menos de 2 min (y nada más).
    stopTv: audioTeleEnabled() ? tvStopperFromVault(vaultGet, tvRequest) : undefined,
    remove: (file) => rmSync(file, { force: true }),
    onError: (err) => log.warn('altavoz: no pude soltar la nota de voz', { err: String(err) }),
  });

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
          const chatId = chatIdOf(scope.split('#')[0] ?? '');
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
  const eraseConfirm = new EraseConfirm();
  /** `${chatKey}:${messageId}` -> thread key, so a reply lands in its conversation. */
  // --- Integraciones opcionales del daemon -----------------------------------
  // MCP: servidores externos (PA_MCP_SERVERS) se arrancan UNA vez y sus tools
  // entran en todos los hilos. Un servidor caído se salta y no impide arrancar.
  const mcpServers = parseMcpServers(process.env.PA_MCP_SERVERS);
  // Entradas con `url` (MCP por HTTP): solo con PA_MCP_HTTP=1.
  const mcpHttpServers = mcpHttpEnabled() ? parseMcpHttpServers(process.env.PA_MCP_SERVERS) : [];
  const mcpTools =
    mcpServers.length || mcpHttpServers.length
      ? await createMcpTools(mcpServers, mcpHttpServers).catch((err: unknown) => {
          log.warn('mcp: no se pudieron arrancar los servidores', { err });
          return [] as AgentTool[];
        })
      : [];
  if (mcpTools.length)
    log.info('mcp: tools listas', {
      servers: mcpServers.length + mcpHttpServers.length,
      tools: mcpTools.length,
    });
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
          // Tarjeta Rutinas: solo lectura, mismo ámbito que Estado. Antes de que
          // arranquen las rutinas (o si algo falla) la ruta responde 503.
          routines: () => {
            try {
              return panelRoutines(
                store.listRoutines(),
                routineRunner.status(),
                (r) => commandRoutineTag(r, commandRoutines, commandRoutinesEnabled()),
                vigilanteOwnerId ?? undefined,
              );
            } catch {
              return null;
            }
          },
          status: () => ({
            model: config.model,
            provider: config.provider,
            threads: threads.size,
            uptimeSeconds: Math.round(process.uptime()),
            // Próximo recordatorio y rutina del dueño (las rutinas arrancan más abajo:
            // antes de eso, o si algo falla, la tarjeta simplemente no los muestra).
            ...(() => {
              try {
                return panelNextUp(
                  routineRunner.status(),
                  (scope: string, name: string) => store.getRoutine(scope, name),
                  vigilanteOwnerId ?? undefined,
                );
              } catch {
                return {};
              }
            })(),
          }),
          sessions: (q?: string) => (q ? sessions.search(q) : sessions.recent(undefined, 20)),
          memory: (scope?: string) =>
            panelMemoryEntries(memory, scope, vigilanteOwnerId ?? undefined),
          memoryScopes: () => memory.scopes(),
          // El mismo ámbito que panelMemoryEntries lee sin `scope` (#555).
          memoryDefaultScope: () =>
            vigilanteOwnerId === undefined || vigilanteOwnerId === null
              ? 'local'
              : `telegram:dm:${String(vigilanteOwnerId)}#main`,
          auditVerify: () => verifyCallAudit(),
          // Chat del panel: corre en el hilo principal del propietario, con el
          // mismo agente, contexto y Gate que Telegram (sin enviar nada al chat).
          chat: async (text: string) => {
            const thread = await getOrCreateThread(
              `telegram:dm:${String(vigilanteOwnerId ?? 'local')}`,
              'main',
              'principal',
            );
            // Paso 2 (ARCHITECTURE.md §5): el turno normal, con la salida al panel.
            // Un mensaje del panel no trae adjuntos ni respuesta citada: solo el texto.
            const base = inboundFor(thread);
            const panelInbound: Inbound = {
              channel: base.channel,
              account: base.account,
              chatId: base.chatId,
              threadId: base.threadId,
              userId: base.userId,
              displayName: base.displayName,
              isGroup: base.isGroup,
              text,
              authorised: true,
              messageId: `${thread.key}#panel`,
              receivedAt: new Date().toISOString(),
            };
            return runPanelChat(thread, text, {
              remember: (t, said) =>
                lastTurns.remember(t.key, {
                  text: said,
                  images: undefined,
                  agent: t.agent,
                  mark: t.agent.messages.length,
                  compactions: t.agent.compactions,
                }),
              runTurn: (t, said, out) => runTurn(t, panelInbound, said, { out, panel: true }),
              // /aprendido y /olvida <n> como en Telegram (borrar sigue siendo escrito).
              command: (t, said) => learnedRulesCommand(memory, memoryScopesFor(t.key).read, said),
            });
          },
          // «Reintentar» del panel: lo mismo que /reintentar en el hilo principal, sin
          // enviar nada a Telegram. Un mensaje con fotos solo se repite desde Telegram
          // (el panel no tiene las fotos): se dice así, no «no hay nada que repetir».
          retry: async () => {
            const thread = await getOrCreateThread(
              `telegram:dm:${String(vigilanteOwnerId ?? 'local')}`,
              'main',
              'principal',
            );
            const last = lastTurns.get(thread.key);
            if (!last) return null;
            if (last.images?.length) return 'con-fotos';
            const base = inboundFor(thread);
            const panelInbound: Inbound = {
              channel: base.channel,
              account: base.account,
              chatId: base.chatId,
              threadId: base.threadId,
              userId: base.userId,
              displayName: base.displayName,
              isGroup: base.isGroup,
              text: last.text,
              authorised: true,
              messageId: `${thread.key}#panel`,
              receivedAt: new Date().toISOString(),
            };
            return runPanelChat(thread, last.text, {
              remember: (t) => {
                rewindLastTurn(last, {
                  agent: t.agent,
                  messages: t.agent.messages,
                  compactions: t.agent.compactions,
                });
                lastTurns.remember(t.key, {
                  ...last,
                  agent: t.agent,
                  mark: t.agent.messages.length,
                  compactions: t.agent.compactions,
                });
              },
              runTurn: (t, said, out) => runTurn(t, panelInbound, said, { out, panel: true }),
            });
          },
          // Aprobaciones pendientes del broker (Telegram y panel ven la misma).
          approvals: () => approvals.list(),
          approve: async (id: string, decision: 'once' | 'session' | 'always' | 'deny') =>
            approvals.resolve(id, decision),
        },
        {
          port: Number(process.env.PA_WEB_PORT),
          allowedHosts: parseAllowedHosts(process.env.PA_WEB_ALLOWED_HOSTS),
        },
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
  // F11 paso 3: `/learn web <url>` (solo con PA_TEACH_DEMO=1).
  const webDemo = new WebDemoRecorder();
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
  /** thread.key -> salida del turno vivo cuando no es Telegram (el panel); ver thread-context.ts. */
  const threadOutputs = new ThreadOutputs();

  const inboundFor = (thread: Thread): Inbound => {
    const live = threadInbound.get(thread.key);
    if (live) return live;
    const { channel, account, chatId, threadId } = parseChatKey(thread.chatKey);
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
    const computerGate: ActionGate = (call) =>
      thread.gate.check(thread.key, { ...call, actor: 'asistenta' });
    const ctx = threadContext({ key: thread.key, outputs: threadOutputs, gate: computerGate });
    const all: AgentTool[] = [
      ...fsTools,
      createFetchTool(),
      createWebTool(config),
      createDoneTool(),
      createAskTool(),
      createShellTool(config),
      delegateTool(config),
      // Each thread has its own gate and its own session key, so batch sub-actions
      // are policed by THIS conversation's approvals and an unwired gate never
      // silently blocks every batch. `sendPhoto` is what lets the model put a
      // capture in the user's chat instead of only in its own context: a
      // screenshot the user cannot see is a screenshot nobody sent.
      // Gate y envío de capturas salen del contexto del hilo: en un turno del panel la
      // captura va al panel (thread-context.ts); en Telegram, igual que siempre.
      // Computer Use como plugin (src/plugins/computer.ts), mismo sitio en la lista.
      ...computerPlugin.tools({
        config,
        screen,
        ctx,
        channelPhoto: async (bytes, opts) => {
          const chatId = chatNumberOf(thread.chatKey);
          const threadId = inboundFor(thread).threadId;
          await telegram.action(chatIdOf(thread.chatKey), 'upload_photo');
          return telegram
            .sendPhotoBytes(chatId, bytes, threadId, opts)
            .then(() => true)
            .catch((err: unknown) => {
              log.warn('desktop screenshot send failed', { err });
              return false;
            });
        },
      }),
      createBrowserTool(browserFor(thread.key), scope, (png) =>
        ctx.sendPhoto(png, () =>
          telegram
            .sendPhotoBytes(chatNumberOf(thread.chatKey), png, inboundFor(thread).threadId)
            .then(() => true),
        ),
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
      // El perfil (PERFIL.md) es del dueño: save_profile/profile/forget_profile solo
      // existen en su chat privado; en grupos y con otros usuarios no hay snapshot.
      createMemoryTool(
        memory,
        scope,
        () => (isOwnerDm(inboundFor(thread), vigilanteOwnerId) ? snapshot : undefined),
        semanticRecall,
        sessions,
      ),
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
      // «Avísame si baja de X»: mismo registro que /vigila, lecturas sin modelo.
      createPriceWatchTool({
        watches: pageWatches,
        scopeOf: () => inboundFor(thread).chatId,
        isFetchable: (url) => isFetchableResolved(url),
      }),
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
      // Adopt a third-party service and serve it back privately (tailnet only):
      // proponer is free, instalar is always-ask in the Gate.
      createServiceTool({ services: adoptedServices, servicesDir: join(paths.state, 'services') }),
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
          ctx.sendFile({ bytes, name: filename }, () =>
            telegram
              .sendDocumentBytes(
                chatNumberOf(thread.chatKey),
                bytes,
                filename,
                caption,
                inboundFor(thread).threadId,
              )
              .then(() => true),
          ),
        saveKindleAddress: (address) => vaultSet(KINDLE_VAULT_KEY, address),
        kindle: {
          getAddress: async () => (await vaultGet(KINDLE_VAULT_KEY)) ?? null,
          loadAccount: loadMailAccount,
          send: sendMail,
          requireApproval: async (_action, summary) => {
            const choice = await telegram.offerApproval(
              randomUUID(),
              chatIdOf(thread.chatKey),
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
          ctx.sendFile({ bytes, name: `${label || 'video'}.mp4` }, () =>
            telegram
              .sendVideo(
                chatNumberOf(thread.chatKey),
                bytes,
                seconds,
                label,
                inboundFor(thread).threadId,
              )
              .then(() => true),
          ),
        sendDocument: (bytes, filename, caption) =>
          ctx.sendFile({ bytes, name: filename }, () =>
            telegram
              .sendDocumentBytes(
                chatNumberOf(thread.chatKey),
                bytes,
                filename,
                caption,
                inboundFor(thread).threadId,
              )
              .then(() => true),
          ),
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
        chatId: chatIdOf(thread.chatKey),
        maxEdge: config.screenshotMaxEdge,
        // Telegram's photo sender wants both dimensions together, and a caller that
        // knows neither has nothing useful to say about the size anyway.
        sendPhoto: (bytes, opts) =>
          ctx
            .sendPhoto(bytes, () => {
              const chatId = chatNumberOf(thread.chatKey);
              const threadId = inboundFor(thread).threadId;
              return opts?.width !== undefined && opts.height !== undefined
                ? telegram.sendPhotoBytes(chatId, bytes, threadId, {
                    width: opts.width,
                    height: opts.height,
                  })
                : telegram.sendPhotoBytes(chatId, bytes, threadId);
            })
            .then((sent) => (sent === true ? 'panel' : sent)),
        sendVideo: (bytes, seconds, label) =>
          ctx.sendFile({ bytes, name: `${label || 'video'}.mp4` }, () =>
            telegram
              .sendVideo(
                chatNumberOf(thread.chatKey),
                bytes,
                seconds,
                label,
                inboundFor(thread).threadId,
              )
              .then(() => true),
          ),
        sendVoice: (bytes, seconds) =>
          ctx.sendFile({ bytes, name: 'nota-de-voz.ogg' }, () =>
            telegram
              .sendVoiceBytes(
                chatNumberOf(thread.chatKey),
                bytes,
                inboundFor(thread).threadId,
                seconds,
              )
              .then(() => true),
          ),
        progress: (what) => telegram.action(inboundFor(thread).chatId, what),
        live: {
          start: (source, intervalSeconds) =>
            startLiveViewFromThread(thread, source, intervalSeconds * 1000),
          stop: () => stopLiveViewFromThread(thread),
        },
        withMicrophone,
        // The speakers are the microphone's other half. Quieten the listener before
        // the sound comes out or the agent answers its own playback.
        // «Reprodúcelo en la tele»: apagado salvo PA_AUDIO_TELE=1 (docs/audio-altavoz.md).
        castToTv: audioTeleEnabled()
          ? tvCasterFromVault(vaultGet, tvRequest, { saveClientKey: saveTvClientKey })
          : undefined,
        // Si la tele aceptó pero nunca bajó el fichero: aviso del firewall al chat.
        notifyChat: (text) => {
          void say(inboundFor(thread), text);
        },
        // /stop en este chat para también lo que «reprodúcelo en la tele» mandó (<2 min).
        onTeleCast: (stop, close) => altavozPlayer.noteTele(thread.chatKey, stop, close),
        beforePlayback: () => currentWake()?.suppress(PLAYBACK_SUPPRESS_MS),
        afterPlayback: () => currentWake()?.suppress(WAKE_TAIL_MS),
      }),
    ] as AgentTool[];

    // La tele LG se mira y se controla por SSAP (src/tv). Las acciones de solo
    // lectura NO entran en el mutex: mirar la tele no mueve la maquina y puede ir
    // en paralelo con una captura del escritorio. El estado de la ultima mirada
    // se guarda en la tabla kv de la Store, para que el agente sepa que habia en
    // pantalla sin volver a despertar la tele.
    // Un mensaje de Telegram viejo (Asistenta apagada) no mueve la tele: src/tv/stale-order.ts.
    all.push(
      ...tvPlugin.tools({ store, staleOrder: () => staleTvOrderNotice(inboundFor(thread).sentAt) }),
    );
    // El iPhone (esp32-iphone-agent): pantalla por AirPlay y toques por ESP32.
    all.push(...iphonePlugin.tools({}));
    // OCR local opcional (PP-OCRv5 / GLM-OCR): sin PA_OCR_LOCAL=1 no aporta nada.
    all.push(...ocrLocalPlugin.tools({}));
    if (mcpTools.length) all.push(...mcpTools);

    // Only the tools that move the machine take the mutex. Wrapping read-only tools
    // would throw away the parallelism that makes multiple conversations worth having.
    const raw = toolsForMode(all, desktop);
    return raw.map((tool): AgentTool => {
      if (!MACHINE_TOOLS.has(tool.name)) return tool;
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

  // La confirmación de una compra (una pregunta por compra y turno): src/daemon/purchase-approvals.ts.
  /** Telegram question with no scope buttons: "always pay" is not a thing. */
  const askOncePerTurn = async (thread: Thread, summary: string): Promise<boolean> => {
    const chatId = chatIdOf(thread.chatKey);
    thread.agent.setAwaitingApproval(true);
    try {
      const choice = await telegram.offerApproval(randomUUID(), chatId, summary);
      return choice.approved;
    } finally {
      thread.agent.setAwaitingApproval(false);
    }
  };
  const purchaseApprovals = createPurchaseApprovals();
  const askCheckout = (thread: Thread, action: string, summary: string): Promise<boolean> =>
    purchaseApprovals.ask(thread.key, action, summary, (q) => askOncePerTurn(thread, q));

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
    const gate = gateFor(key, chatIdOf(chatKey_), holder);
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
            .allIn(memoryScopesFor(key).read)
            .filter((e) => e.supersededBy === null)
            .map((e) => e.text),
        write: (facts) => {
          let written = 0;
          const active = memory
            .allIn(memoryScopesFor(key).read)
            .filter((e) => e.supersededBy === null)
            .map((e) => e.text);
          for (const fact of dedupeNewFacts(active, facts)) {
            try {
              memory.remember(memoryScopesFor(key).write, fact, { tags: ['compaction'] });
              written++;
            } catch (err) {
              log.warn('compaction fact refused by memory store', { err: String(err) });
            }
          }
          return written;
        },
      },
    });
    // /modelo guardado: solo si sigue configurado (chooseModel lo comprueba).
    const savedModel = modelChoices.get(key);
    if (savedModel) thread.agent.chooseModel(savedModel);
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
  const resolveThread = (inbound: Inbound): Promise<Thread> =>
    resolveInboundThread(inbound, chatKey(inbound), {
      activeTopic,
      messageThread,
      threads,
      goalScopeBySentId: (key, sentId) => goalNotifier.scopeBySentId(key, sentId),
      splitGoalScope,
      getOrCreateThread,
      defaultThread,
      looksLikeFollowUp,
    });

  const say = async (
    inbound: Inbound,
    text: string,
    opts: {
      audio?: ChannelAudio;
      images?: Inbound['images'];
      quote?: boolean;
      format?: Outbound['format'];
      buttons?: Outbound['buttons'];
      /** Cada id de mensaje enviado (todos los trozos), p. ej. para apuntar su hilo. */
      onSent?: (messageId: string) => void;
    } = {},
  ): Promise<string | null> => {
    return telegram
      .send(
        {
          channel: 'telegram',
          account: telegram.account,
          chatId: inbound.chatId,
          threadId: inbound.threadId,
          // The answer quotes the message it answers. Without this, three concurrent
          // conversations in one chat are unreadable: you cannot tell which reply
          // belongs to which request.
          replyToMessageId: opts.quote === false ? undefined : inbound.messageId,
          text,
          format: opts.format,
          images: opts.images,
          audio: opts.audio,
          buttons: opts.buttons,
        },
        opts.onSent,
      )
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
    // keepMarks: títulos y **negritas** salen en negrita de verdad (HTML escapado,
    // con texto plano de respaldo si Telegram rechaza el formato).
    const cleaned = cleanForTelegram(stripVoicePrefix(text.trim()), { keepMarks: true });
    const short = shorten(cleaned);
    let audio: ChannelAudio | undefined;
    if (desktop && wantsVoice && inbound.audioFileId && text.trim()) {
      // Con tope: un SAPI lento o colgado no puede retener la respuesta escrita.
      const spoken = await speakWithin(tts, trimForSpeech(text), REPLY_TTS_BUDGET_MS, (reason) =>
        log.warn('tts failed, sending text only', { reason }),
      );
      if (spoken) {
        audio = {
          mimeType: spoken.mimeType,
          data: spoken.data.toString('base64'),
          durationSeconds: spoken.durationSeconds,
        };
      }
    }
    // «Dime más» solo tiene sentido si se recortó algo. Antes se guardaba CUALQUIER
    // respuesta, y un «sigue»/«más» posterior reenviaba la anterior sin tocar el
    // agente; ahora una respuesta entera borra la copia de la anterior.
    if (short.truncated && text.trim()) cacheFullReply(thread.key, text.trim());
    else takeFullReply(thread.key);
    // Recortada: botón «📖 Ver todo» (además de poder escribir «más»).
    const buttons =
      short.truncated && text.trim()
        ? [moreButton(thread.key, inbound.chatId, inbound.threadId)]
        : undefined;
    // Todos los trozos apuntan al hilo (antes solo el primero): responder al segundo
    // trozo de una respuesta larga sigue esta conversación.
    const id = await say(inbound, short.text, {
      audio,
      format: 'marks',
      buttons,
      onSent: threadForSentIds(messageThread, chatKey(inbound), thread.key),
    });
    if (id) messageThread.set(`${chatKey(inbound)}:${id}`, thread.key);
    // PA_ALTAVOZ_VOZ=1: la respuesta también suena donde sonó la nota (PC/tele), tras
    // el texto y sin esperarla. Reutiliza la voz ya hecha para Telegram si la hay.
    routeReplyToAltavoz(inbound, text, {
      enabled: altavozVoiceReplyEnabled(),
      mode: altavoz.get(chatKey(inbound)),
      desktop,
      ownerUserId: vigilanteOwnerId,
      player: altavozPlayer,
      speak: async () => {
        if (audio) return { data: Buffer.from(audio.data, 'base64'), mimeType: audio.mimeType };
        const spoken = await speakWithin(tts, trimForSpeech(text), REPLY_TTS_BUDGET_MS, (reason) =>
          log.warn('altavoz: sin voz para la respuesta', { reason }),
        );
        return spoken ? { data: spoken.data, mimeType: spoken.mimeType } : null;
      },
      reply: (notice) => {
        void say(inbound, notice, { quote: true });
      },
      key: chatKey(inbound),
      onError: (err) => log.warn('altavoz: no pude decir la respuesta', { err: String(err) }),
    });
    if (short.truncated) {
      log.info('reply shortened', { chars: cleaned.length, thread: thread.name });
    }
  };

  // La autoactualización solo reinicia con este fichero diciendo «libre».
  trackBusyIn(paths.state);
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
    // A goal's messages go to the chat (and thread) that owns the goal, and nowhere else.
    send: createGoalNotifySend({ telegram, messageThread, log }),
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
  // Tick de objetivo y tarea de rutina: src/daemon/goal-tick.ts y routine-task.ts.
  const threadTickDeps = {
    threadFor: getOrCreateThread,
    sessions,
    contextNoteFor: (thread: Thread, prompt: string) =>
      buildContextNote(
        thread,
        store,
        memory,
        snapshot,
        workstreams,
        skills,
        sessions,
        ownerProfile,
        prompt,
        isOwnerDm(inboundFor(thread), vigilanteOwnerId),
        projectContexts,
      ),
    safeRemember,
  };
  const goalTickExecute = createGoalTickExecute({ ...threadTickDeps, actions });
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
    execute: goalTickExecute,
  });

  const runRoutineTask = createRoutineTask(threadTickDeps);

  const routineDelivery = new RoutineDeliveryStore(join(paths.state, 'routine-delivery.json'));
  const sendToChat = (
    chatId: string,
    text: string,
    buttons?: Array<{ label: string; action: string }>,
  ) => telegram.send({ channel: 'telegram', account: telegram.account, chatId, text, buttons });
  // Botones de los avisos: en disco para que sigan sirviendo tras reiniciar (auto-update).
  const firedReminders = new FiredReminders(
    Date.now,
    200,
    join(paths.state, 'botones', 'recordatorios.json'),
  );
  // F4: rutinas de comando (sin modelo), apagadas salvo PA_CRON_COMANDOS=1.
  const commandRoutines = new CommandRoutineStore(join(paths.state, 'command-routines.json'));
  const runRoutineFire = createRoutineFire({
    store,
    fireCommand: commandRoutinesEnabled()
      ? (ctx) => fireCommandRoutine(commandRoutines, ctx.routine, { enabled: true })
      : undefined,
    tickGoal: (name) => goalRunner.tickByRoutineName(name),
    runTask: runRoutineTask,
    send: sendToChat,
    reminderButtons: (scope, text) => reminderButtons(firedReminders.remember(scope, text)),
    delivery: routineDelivery,
    outputDir: join(paths.state, 'salidas'),
    sync: () => routineRunner.sync(),
    droppedRemindersPath: join(paths.state, 'dropped-reminders.jsonl'),
  });

  // F1: recupera una vez el último disparo perdido con el PC apagado o dormido,
  // dentro de su ventana de gracia. PA_ROUTINE_CATCHUP=0 lo desactiva.
  const routineRunner = new RoutineRunner({
    store,
    run: runRoutineFire,
    catchUp: process.env.PA_ROUTINE_CATCHUP !== '0',
  });
  // Overdue one-time reminders are delivered and deleted BEFORE the scheduler starts,
  // so a job due this minute cannot also fire fresh (see deliverMissedThenStart).
  void deliverMissedThenStart({
    store,
    send: sendToChat,
    reminderButtons: (scope, text) => reminderButtons(firedReminders.remember(scope, text)),
    start: () => routineRunner.start(),
  });

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
  // Chat privado del dueño (DM de Telegram verificado). Vigilante y resumen diario se
  // mandan ahí, así que solo leen los seguimientos de ese chat, no los de los grupos.
  const ownerDmFollowupKey = (): string | undefined => {
    const keys = [...threads.values()].map((t) => t.chatKey);
    const chatId = resolveOwnerDmChatId(keys, vigilanteOwnerId);
    return chatId ? ownerDmKeyFor(keys, chatId) : undefined;
  };
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
              // Los mismos 35 días que pide la agenda de abajo (sin esto, el calendario
              // solo se leía 7 días y las caducidades a 30 días nunca llegaban de él).
              days: calendarDaysFor(VIGILANTE_AGENDA_DAYS),
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
          followups: () => ownerDmFollowups(followups, ownerDmFollowupKey()),
          // 35 días: las caducidades avisan a 30 días; lo demás sigue en 7 (collectFindings).
          days: VIGILANTE_AGENDA_DAYS,
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
        if (!account) {
          await say(
            inbound,
            'No tienes configurada la lectura del correo. «/correo estado» te dice qué falta.',
            { quote: true },
          );
          return;
        }
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
      } catch (err) {
        log.warn('mail list failed', redact({ err }));
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
        await telegram.sendVideo(
          Number(inbound.chatId),
          bytes,
          seconds,
          'Pantalla',
          inbound.threadId,
        );
        log.info('watch clip sent', { chatId: inbound.chatId, bytes: bytes.length });
      } catch (err) {
        await say(inbound, ownerFailNote('clip', err), {
          quote: true,
        });
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
      const web = await webDemo.finish(thread.key, {
        browser: browserFor(thread.key),
        store: playbooks,
        vaultValues: vaultSnapshotValues,
      });
      if (web !== null) {
        await say(inbound, web, { quote: true });
        return;
      }
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
    const webArg = /^web(?:\s+(.*))?$/i.exec(name);
    if (webArg) {
      const msg = await webDemo.start(thread.key, webArg[1] ?? '', {
        browser: browserFor(thread.key),
      });
      if (msg !== null) {
        await say(inbound, msg, { quote: true });
        return;
      }
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
    // F4: una rutina de comando jamás se manda al modelo.
    if (isCommandRoutine(routine)) {
      await say(
        inbound,
        `"${routine.name}" es una rutina de comando: pruébala con /cron probar ${routine.name}.`,
        { quote: true },
      );
      return;
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
    const text = marksWithTitles(
      runCronCommand(
        {
          store,
          routineRunner,
          threadKey: thread.key,
          chatKey: chatKey(inbound),
          delivery: routineDelivery,
          commands: commandRoutines,
          isOwner: isOwnerDm(inbound, vigilanteOwnerId),
          commandCwd: homedir(),
          goals: goalStore,
        },
        args,
      ),
      isCronTitle,
    );
    // Solo la lista (/cron sin más) lleva botones; las respuestas de una suborden no.
    const buttons = args.trim()
      ? undefined
      : cronListButtons(store.listRoutines().filter((r) => inChatScope(r.scope, chatKey(inbound))));
    await say(inbound, text, { quote: true, format: 'marks', buttons });
  };

  /**
   * The scheduled half of the routines, with their next fire.
   *
   * The live runner is the source of truth for "when": it is what will actually
   * fire, held first runs included. The store is the source of truth for what
   * exists, so a routine that failed to register is still listed instead of
   * silently missing from the agenda.
   */
  const scheduledAgenda = (inbound: Inbound): string =>
    scheduledAgendaText({
      store,
      routineRunner,
      chatKey: chatKey(inbound),
      commands: commandRoutines,
    });

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
        followups: () => followups.forChat(chatKey(inbound), 200),
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
    await say(inbound, marksWithTitles(text, isAgendaTitle), { quote: true, format: 'marks' });
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
  // «👀 Vigilar» de /compara: id corto → enlace (una vez, 24 h, mismo chat).
  const compareWatchLinks = new CompareWatchLinks(
    Date.now,
    200,
    join(paths.state, 'botones', 'compara.json'),
  );
  const cmdVigila = async (inbound: Inbound, rawArgs: string): Promise<void> => {
    let args = rawArgs;
    const fromButton = /^enlace ([0-9a-f]{8})$/.exec(rawArgs.trim());
    if (fromButton?.[1]) {
      const hit = compareWatchLinks.takeEntry(fromButton[1], inbound.chatId);
      if (!hit) return void (await say(inbound, COMPARE_WATCH_STALE, { quote: true }));
      args = vigilaArgsFromCompare(hit);
    }
    const silence = vigilaSilenceArgs(rawArgs);
    if (silence) {
      const w =
        silence.action === 'silenciar'
          ? pageWatches.mute(inbound.chatId, silence.id, PAGE_MUTE_MS)
          : pageWatches.unmute(inbound.chatId, silence.id);
      const reply = vigilaSilenceReply(silence.action, w);
      return void (await say(inbound, reply.text, {
        quote: true,
        ...(reply.buttons.length ? { buttons: reply.buttons } : {}),
      }));
    }
    let parsed: ReturnType<typeof parseVigilaArgs>;
    try {
      parsed = parseVigilaArgs(args);
    } catch (err) {
      return void (await say(inbound, friendlyError(err), { quote: true }));
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
      await say(inbound, friendlyError(err), { quote: true });
    }
  };

  const cmdVigilando = async (inbound: Inbound): Promise<void> => {
    const list = pageWatches.list(inbound.chatId);
    const text = formatWatchList(list);
    await say(inbound, marksWithTitles(text, isWatchListTitle), {
      quote: true,
      format: 'marks',
      buttons: watchListButtons(list),
    });
  };

  /** /vigilancias: todo lo que vigilo en este chat (páginas, precios, rutinas, ojo); solo lectura. */
  const cmdVigilancias = async (inbound: Inbound): Promise<void> => {
    const { collectWatches, defaultSources } = await import('./watch/overview-cli.js');
    const { entries, errors } = collectWatches(defaultSources());
    const r = vigilanciasReply(entries, inbound.chatId);
    const note = vigilanciasErrorNote(errors);
    await say(inbound, r.text + note, { quote: true, format: 'marks', buttons: r.buttons });
  };

  /** /precio <id>: histórico de la vigilancia (mín/mediana/máx, evolución y avisos). */
  // «🔕 Silenciar 1 día» / «🔔 Avisar otra vez» de un aviso del vigilante de precios
  // (pricewatch): solo desde el chat al que avisa ese vigilante.
  const cmdPrecioMute = async (
    inbound: Inbound,
    m: { action: 'silenciar' | 'avisar'; key: string },
  ): Promise<void> => {
    const cfgPath = process.env.PRICEWATCH_CONFIG ?? join(paths.state, 'pricewatch.json');
    let chatId = '';
    try {
      chatId = parsePricewatchConfig(JSON.parse(readFileSync(cfgPath, 'utf8'))).telegram.chatId;
    } catch {
      chatId = '';
    }
    if (!chatId || chatId !== inbound.chatId) {
      return void (await say(inbound, 'Ese aviso de precio no es de este chat.', { quote: true }));
    }
    const db = new DatabaseSync(join(paths.state, 'pricewatch.sqlite'));
    let hit: { product: string; until: number } | null = null;
    try {
      const pw = new PriceStore(db);
      if (m.action === 'silenciar') hit = pw.mute(m.key, PRICE_MUTE_MS);
      else {
        const product = pw.unmute(m.key);
        hit = product ? { product, until: 0 } : null;
      }
    } finally {
      db.close();
    }
    const reply = pricewatchMuteReply(m.action, m.key, hit);
    await say(inbound, reply.text, {
      quote: true,
      ...(reply.buttons.length ? { buttons: reply.buttons } : {}),
    });
  };
  const cmdPrecio = async (inbound: Inbound, args: string): Promise<void> => {
    const mute = precioMuteArgs(args);
    if (mute) return void (await cmdPrecioMute(inbound, mute));
    const id = args.trim();
    const w = id
      ? pageWatches.list(inbound.chatId).find((x) => x.id === id || x.id.startsWith(id))
      : undefined;
    if (!w) {
      return void (await say(inbound, 'No encuentro ese id. Mira /vigilando.', { quote: true }));
    }
    await say(inbound, marksCardTitle(describeWatch(w, pageWatches.summary(w.id))), {
      quote: true,
      format: 'marks',
    });
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
      await say(inbound, marksCardTitle(describeCompare(report)), {
        quote: true,
        format: 'marks',
        buttons: compareWatchButtons(
          compareWatchLinks.remember(inbound.chatId, url),
          ...compareTargetButton(report, (t) => compareWatchLinks.remember(inbound.chatId, url, t)),
        ),
      });
    } catch (err) {
      await say(inbound, friendlyError(err), { quote: true });
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
    const wide = /^amplio\b/i.test(question);
    if (wide) {
      // F8: «/investiga amplio <pregunta> | a, b, c» → una fila por elemento.
      if (!wideResearchEnabled()) {
        return void (await say(
          inbound,
          'La investigacion amplia esta desactivada (hace una consulta al modelo por elemento). Activala con PA_INVESTIGA_AMPLIO=1 y reinicia Asistenta.',
          { quote: true },
        ));
      }
      const parsed = parseWideArgs(question.replace(/^amplio\b/i, ''));
      if (!parsed) {
        return void (await say(
          inbound,
          `Uso: /investiga amplio <pregunta> | elemento1, elemento2, ... (hasta ${WIDE_MAX_ITEMS}). Ejemplo: /investiga amplio precio y garantia | iPhone 16, Pixel 9, Galaxy S25`,
          { quote: true },
        ));
      }
      await say(
        inbound,
        `Me pongo con ${parsed.items.length} elementos, 3 a la vez, cada uno con su fuente. Tardo 1-3 minutos.`,
        { quote: true },
      );
      try {
        const router = new WebRouter({
          backends: await buildWebBackends(),
          maxCostEur: config.webMaxCostEur,
          metricsPath: paths.webMetrics,
        });
        const report = await wideResearch(parsed.question, parsed.items, {
          search: async (q, max) => (await router.routeSearch(q, { maxResults: max })).result.items,
          fetch: async (url, maxChars) => (await router.routeFetch(url, { maxChars })).result.text,
          llm: await researchLlm(),
        });
        await say(inbound, renderWideReport(report), { quote: true });
        // La misma tabla como CSV adjunto, para abrirla en una hoja (solo Telegram).
        const csv = inbound.channel === 'telegram' ? wideCsvAttachment(report) : null;
        if (csv) {
          await telegram
            .sendDocumentBytes(
              Number(inbound.chatId),
              csv.bytes,
              csv.filename,
              csv.caption,
              inbound.threadId,
            )
            .catch((err) => log.warn('investiga amplio: csv no enviado', { err: String(err) }));
        }
      } catch (err) {
        await say(inbound, friendlyError(err), { quote: true });
      }
      return;
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
      await say(inbound, friendlyError(err), { quote: true });
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
    const notice = pageNotice(w, outcome, Date.now());
    if (outcome.kind === 'changed') {
      actions.record({
        actor: 'asistenta',
        action: 'vigila_cambio',
        target: w.label || w.url,
        result: 'ok',
      });
    }
    if (notice) {
      await telegram
        .send({
          channel: 'telegram',
          account: telegram.account,
          chatId: w.scope,
          text: notice.text,
          ...(notice.buttons.length ? { buttons: notice.buttons } : {}),
        })
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
      // Solo los pendientes de ESTE chat: con varios usuarios permitidos, cada uno
      // recibía en su privado los de todos.
      pending: followups.safe(
        () =>
          followups.summarize(Date.now(), {
            chatKey: chatKey({ channel: 'telegram', account: telegram.account, chatId }),
          }),
        '',
      ),
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

  /**
   * Resumen de la mañana (opt-in PA_BRIEFING=1): agenda de hoy, correo sin leer que
   * importa, tiempo (si hay PA_BRIEFING_LAT/LON), rutinas, recordatorios y
   * seguimientos. Solo al DM del dueño verificado; ritmo en src/briefing-daily.ts.
   */
  const ownerChatKey = (chatId: string): string | undefined =>
    ownerDmKeyFor(
      [...threads.values()].map((t) => t.chatKey),
      chatId,
    );
  const briefingOwner = (): string | null =>
    resolveOwnerDmChatId(
      [...threads.values()].map((t) => t.chatKey),
      vigilanteOwnerId,
    );
  const briefingWeather = weatherConfigFromEnv();
  const briefingDeps: DailyBriefingDeps = {
    enabled: () => process.env.PA_BRIEFING === '1',
    now: () => new Date(),
    hour: Number.parseInt(process.env.PA_BRIEFING_HOUR ?? '', 10) || undefined,
    lastSent: () => weeklyState.lastSent('briefing'),
    markSent: (at) => weeklyState.markSent('briefing', at),
    owner: briefingOwner,
    send: (chatId, text) =>
      telegram
        .send({ channel: 'telegram', account: telegram.account, chatId, text })
        .then(() => true),
    agenda: async () => {
      const agenda = await buildAgenda({
        calendar: async () =>
          (
            await loadCalendar({
              readLocal: () => readLocalCalendar(join(paths.state, 'calendar', 'local.ics')),
              getUrl: () => vaultGet('calendar:icsUrl'),
              fetchText: async (url) => {
                const res = await fetch(url, {
                  redirect: 'follow',
                  signal: AbortSignal.timeout(15_000),
                });
                if (!res.ok) throw new Error(`el calendario ha respondido ${res.status}`);
                return res.text();
              },
              days: 1,
            })
          ).events,
        days: 1,
      });
      return agendaTodayLines(agenda.today, localTimeZone());
    },
    mail: async () => {
      const account = await loadMailAccount();
      if (!account) return [];
      const since = Date.now() - 24 * 3_600_000;
      const messages = await searchMail(account, { since, unreadOnly: true }, 30, 15_000);
      return pickImportantMail(messages, Date.now());
    },
    speak:
      process.env.PA_BRIEFING_VOZ === '1' && desktop
        ? briefingSpeaker({
            synth: (text) =>
              speakWithin(tts, trimForSpeech(text), REPLY_TTS_BUDGET_MS, (reason) =>
                log.warn('briefing: sin voz', { reason }),
              ),
            send: (chatId, spoken) =>
              telegram.send({
                channel: 'telegram',
                account: telegram.account,
                chatId,
                text: '🔊 Resumen de hoy',
                audio: {
                  mimeType: spoken.mimeType,
                  data: spoken.data.toString('base64'),
                  durationSeconds: spoken.durationSeconds,
                },
              }),
          })
        : undefined,
    goals: () => {
      const owner = briefingOwner();
      const key = owner ? ownerChatKey(owner) : undefined;
      if (!key) return [];
      return goalStore
        .list()
        .filter((g) => g.scope === key || g.scope.startsWith(`${key}#`))
        .filter((g) => g.status === 'active' || g.status === 'blocked')
        .map((g) => ({
          title: g.title,
          status: g.status as 'active' | 'blocked',
          next:
            g.status === 'blocked'
              ? (g.blockedReason ?? undefined)
              : g.plan.find((s) => !s.done)?.text,
        }));
    },
    watches: () => {
      const owner = briefingOwner();
      if (!owner) return [];
      return pageWatches
        .list(owner)
        .filter((w) => w.active && (w.targetCents !== null || w.dropPct !== null))
        .map((w) => ({
          label: w.label || w.url,
          lastCents: pageWatches.summary(w.id)?.lastCents ?? null,
          targetCents: w.targetCents,
        }));
    },
    weather: briefingWeather ? () => fetchWeatherLine(briefingWeather) : undefined,
    ...(() => {
      const today = () => {
        const owner = briefingOwner();
        const key = owner ? ownerChatKey(owner) : undefined;
        if (!key) return { routines: [], reminders: [] };
        const live = new Map(
          routineRunner.status().map((s) => [`${s.scope}\u0000${s.name}`, s.next]),
        );
        return scheduledForToday(
          store
            .listRoutines()
            .filter((r) => r.kind === 'schedule' && inChatScope(r.scope, key))
            .map((r) => ({
              name: r.name,
              prompt: r.prompt,
              enabled: r.enabled,
              next: live.get(`${r.scope}\u0000${r.name}`) ?? null,
            })),
          new Date(),
          localTimeZone(),
        );
      };
      return {
        routines: () => today().routines,
        reminders: () => today().reminders,
      };
    })(),
    followups: () => followupsDue(ownerDmFollowups(followups, ownerDmFollowupKey()), new Date()),
    warn: (msg, meta) => log.warn(msg, meta ?? {}),
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
          text: backupFailedNotice(err),
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

  /**
   * Retención de conversaciones (src/maintenance.ts): una vez al día, a partir de las
   * 04:00, borra las sesiones TERMINADAS de hace más de PA_SESSION_RETENTION_DAYS días
   * (365 por defecto; 0 la apaga). Sin esto la base de sesiones crecía sin límite.
   */
  const retentionTick = (): void => {
    try {
      const r = retentionIfDue({
        db: memoryDb,
        now: new Date(),
        lastRunMs: weeklyState.lastSent('retencion'),
        markRun: (at) => weeklyState.markSent('retencion', at),
        pruneDocs: (ms) => docMemory.pruneOlderThan(ms),
        stateDir: paths.state,
      });
      if (r.ran)
        log.info('retention done', {
          sessions: r.sessions,
          documents: r.documents,
          files: r.files,
        });
    } catch (err) {
      log.warn('session retention failed', { err: String(err) });
    }
  };

  const cmdEvolucion = async (inbound: Inbound, args: string): Promise<void> => {
    const a = args.trim();
    if (/^idea\b/i.test(a)) {
      try {
        addHypothesis(paths.state, a.replace(/^idea\s*/i, ''));
        await say(inbound, 'Anotada. La probará el próximo ciclo.', { quote: true });
      } catch (err) {
        await say(inbound, failedReply('No la he anotado', err), { quote: true });
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

  const cmdResumen = async (inbound: Inbound, args = ''): Promise<void> => {
    if (/^(hoy|dia|día|manana|mañana)$/i.test(args.trim())) {
      // El resumen de la mañana bajo demanda: misma composición, sin tocar el ritmo.
      if (!isOwnerDm(inbound, vigilanteOwnerId)) {
        await say(
          inbound,
          'El resumen del día solo está disponible en el chat privado del dueño.',
          {
            quote: true,
          },
        );
        return;
      }
      await answerBriefingOnDemand(briefingDeps, inbound.chatId, (text) =>
        say(inbound, text, { quote: true }),
      );
      return;
    }
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
      retentionTick();
    },
    10 * 60 * 1000,
  );
  pageWatchTimer.unref();
  // El resumen diario se comprueba cada minuto (antes, cada 2 h con las vigilancias).
  startDailyBriefingTimer(briefingDeps);

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
      return async (text: string, opts?: PriceNotifyOpts) => {
        void triggerEngine.emit({ type: 'precio', scope: '', text }).catch((err) => {
          log.warn('trigger precio falló', { err: String(err) });
        });
        return notify(
          text,
          opts?.muteKey ? { ...opts, buttons: pricewatchMuteButtons(opts.muteKey) } : opts,
        );
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

  /** /recordatorios [borrar <n|palabra>]: ver y quitar recordatorios sin pasar por el modelo. */
  // /borrar_chat: borrado irreversible, solo el dueño en privado y con «BORRAR» después.
  const cmdBorrarChat = async (inbound: Inbound): Promise<void> => {
    if (!isOwnerDm(inbound, vigilanteOwnerId)) {
      await say(inbound, 'Este comando solo funciona en el chat privado del dueño.', {
        quote: true,
      });
      return;
    }
    eraseConfirm.request(chatKey(inbound));
    await say(inbound, ERASE_PROMPT, { quote: true });
  };
  const cmdBorrarChatConfirmado = async (inbound: Inbound): Promise<void> => {
    if (!isOwnerDm(inbound, vigilanteOwnerId)) return;
    const ck = chatKey(inbound);
    const live = [...threads.values()].filter((t) => t.chatKey === ck);
    if (live.some((t) => t.active)) {
      await say(
        inbound,
        'Hay una tarea en marcha en este chat. Usa /stop y vuelve a pedir /borrar_chat. No he borrado nada.',
        { quote: true },
      );
      return;
    }
    const result = eraseChat({
      stateDir: paths.state,
      chatKey: ck,
      liveScopes: live.map((t) => t.key),
      db: memoryDb,
      projects: projectContexts,
      models: modelChoices,
      followups,
    });
    for (const t of live) threads.delete(t.key);
    await say(inbound, eraseSummary(result), { quote: true });
  };
  // F13: liga una carpeta de proyecto (su ASISTENTA.md/AGENTS.md entra en el contexto).
  const cmdProyecto = async (inbound: Inbound, args: string): Promise<void> => {
    if (!isOwnerDm(inbound, vigilanteOwnerId)) {
      await say(
        inbound,
        'Solo el dueño, en su chat privado, puede ligar una carpeta de proyecto.',
        {
          quote: true,
        },
      );
      return;
    }
    const thread = await resolveThread(inbound);
    const arg = cleanProjectPath(args);
    const verb = arg.toLowerCase();
    if (verb === 'quitar' || verb === 'off' || verb === 'desligar') {
      const had = projectContexts.unlink(thread.key);
      await say(inbound, had ? 'Carpeta de proyecto desligada.' : 'No había carpeta ligada.', {
        quote: true,
      });
      return;
    }
    if (!arg || verb === 'estado') {
      const dir = projectContexts.get(thread.key);
      const ctx = projectContexts.load(thread.key);
      const state = !dir
        ? 'Sin carpeta de proyecto en esta conversación.'
        : ctx?.ok
          ? `Proyecto: ${ctx.dir} — cargo ${ctx.name} (${ctx.bytes} bytes) en cada turno.`
          : `Proyecto: ${dir} — ahora no cargo nada: ${ctx?.ok === false ? ctx.reason : 'sin fichero'}.`;
      await say(inbound, `${state}\nUso: /proyecto <carpeta> · /proyecto quitar`, { quote: true });
      return;
    }
    const ctx = projectContexts.link(thread.key, arg);
    if (!ctx.ok) {
      await say(inbound, `No la ligo: ${ctx.reason}.`, { quote: true });
      return;
    }
    const first = ctx.text.trim().split('\n')[0]?.slice(0, 80) ?? '';
    await say(
      inbound,
      `Ligada ${ctx.dir}. Cargo ${ctx.name} (${ctx.bytes} bytes) en cada turno de esta conversación${first ? `: «${first}»` : ''}.`,
      { quote: true },
    );
  };

  // F7: /reintentar repite el último mensaje sin la respuesta anterior en el historial.
  const cmdReintentar = async (inbound: Inbound): Promise<void> => {
    const thread = await resolveThread(inbound);
    const last = lastTurns.get(thread.key);
    if (!last) {
      await say(inbound, 'No tengo un mensaje tuyo reciente en esta conversación que repetir.', {
        quote: true,
      });
      return;
    }
    const next = queueThreadTurn(thread, async () => {
      const removed = rewindLastTurn(last, {
        agent: thread.agent,
        messages: thread.agent.messages,
        compactions: thread.agent.compactions,
      });
      lastTurns.remember(thread.key, {
        ...last,
        agent: thread.agent,
        mark: thread.agent.messages.length,
        compactions: thread.agent.compactions,
      });
      await say(
        inbound,
        removed > 0
          ? `Repito: «${last.text.slice(0, 80)}» (sin la respuesta anterior).`
          : `Repito: «${last.text.slice(0, 80)}». El historial cambió desde entonces, así que la respuesta anterior se queda.`,
        { quote: true },
      );
      await runTurn(thread, { ...inbound, text: last.text, images: last.images }, last.text, {
        images: last.images,
      });
    });
    await next;
  };

  // F7: /compactar resume el historial ya, sin esperar al umbral.
  const cmdCompactar = async (inbound: Inbound): Promise<void> => {
    const thread = await resolveThread(inbound);
    const next = queueThreadTurn(thread, async () => {
      try {
        const r = await thread.agent.compactNow();
        // Los índices del historial ya no valen: /reintentar no rebobina.
        await say(
          inbound,
          r.compacted
            ? `Historial resumido: ~${formatTokens(r.before)} → ~${formatTokens(r.after)} tokens.`
            : `No lo resumo: ${r.reason ?? 'nada que resumir'} (~${formatTokens(r.before)} tokens).`,
          { quote: true },
        );
      } catch (err) {
        await say(inbound, failedReply('No pude resumir el historial', err), {
          quote: true,
        });
      }
    });
    await next;
  };

  // /modelo: avisa si el modelo nuevo tiene mucha menos ventana o no ve imágenes.
  // PA_CONTEXT_WINDOW describe solo PA_MODEL; los demás usan su ficha del catálogo.
  const modeloWarningText = (prevId: string, nextId: string): string => {
    const caps = (id: string) =>
      resolveModelCaps({ ...config, model: id }, { envOverrides: id === config.model });
    const warnings = modelSwitchWarnings(caps(prevId), caps(nextId));
    return warnings.length ? `\n${warnings.join('\n')}` : '';
  };

  // F7: /modelo ve o elige el modelo de esta conversación (solo el dueño, en privado).
  const cmdModelo = async (inbound: Inbound, args: string): Promise<void> => {
    if (!isOwnerDm(inbound, vigilanteOwnerId)) {
      await say(inbound, 'El modelo solo se cambia desde tu chat privado conmigo.', {
        quote: true,
      });
      return;
    }
    const thread = await resolveThread(inbound);
    const action = parseModelo(args, thread.agent.availableModels);
    if (action.kind === 'show') {
      await say(inbound, formatModelos(thread.agent.availableModels, thread.agent.modelId), {
        quote: true,
      });
      return;
    }
    if (action.kind === 'error') {
      await say(inbound, action.text, { quote: true });
      return;
    }
    // En cola: no cambia el modelo a mitad de un turno de esta conversación.
    const next = queueThreadTurn(thread, async () => {
      const prevModel = thread.agent.modelId;
      const r = thread.agent.chooseModel(action.id);
      if (r.ok)
        modelChoices.set(
          thread.key,
          r.model === thread.agent.availableModels[0] ? undefined : r.model,
        );
      await say(
        inbound,
        r.ok
          ? `Listo: esta conversación usa ${r.model}${r.model === thread.agent.availableModels[0] ? ' (el principal)' : ''}.${modeloWarningText(prevModel, r.model)}`
          : `No cambio el modelo: ${r.reason}.`,
        { quote: true },
      );
    });
    await next;
  };

  /** /altavoz [pc|tele|off]: notas de voz que suenan solas al llegar (solo el dueño, en privado). */
  const cmdAltavoz = async (inbound: Inbound, args: string): Promise<void> => {
    if (!isOwnerDm(inbound, vigilanteOwnerId)) {
      await say(inbound, 'El altavoz solo se controla desde tu chat privado conmigo.', {
        quote: true,
      });
      return;
    }
    if (!desktop) {
      await say(inbound, DESKTOP_OFF_MESSAGE, { quote: true });
      return;
    }
    const key = chatKey(inbound);
    const parsed = parseAltavozArgs(args);
    if (parsed.kind === 'error') {
      await say(inbound, ALTAVOZ_USAGE, { quote: true });
      return;
    }
    if (parsed.kind === 'set') {
      if (parsed.mode === 'tele' && !audioTeleEnabled()) {
        await say(
          inbound,
          'La tele no está activada para audio. Pon PA_AUDIO_TELE=1 en el .env y reinicia; mientras, /altavoz pc.',
          { quote: true },
        );
        return;
      }
      altavoz.set(key, parsed.mode);
    }
    await say(inbound, altavozStatusText(altavoz.get(key)), { quote: true });
  };

  const cmdRecordatorios = async (inbound: Inbound, args: string): Promise<void> => {
    const thread = await resolveThread(inbound);
    const scope = thread.key;
    const rows = () => reminderRows(store.listRoutines(scope));
    const b = /^(hecho|pospone|manana) ([0-9a-f]{8})$/.exec(args.trim());
    if (b?.[2]) {
      const reply = reminderButtonCommand(
        {
          fired: firedReminders,
          store,
          sameChat: (s) => chatIdOfScope(s) === inbound.chatId,
        },
        b[1] === 'hecho' ? 'hecho' : b[1] === 'manana' ? 'manana' : 'pospone',
        b[2],
      );
      if (b[1] !== 'hecho') routineRunner.sync();
      await say(inbound, reply, { quote: true });
      return;
    }
    const m = /^(borrar|cancelar|quitar|del)\b\s*(.*)$/i.exec(args.trim());
    if (!m) {
      if (args.trim()) {
        await say(inbound, 'Uso: /recordatorios ⬦ /recordatorios borrar <número o palabra>', {
          quote: true,
        });
        return;
      }
      await say(inbound, marksWithTitles(formatReminderRows(rows()), isReminderTitle), {
        quote: true,
        format: 'marks',
      });
      return;
    }
    const pick = pickReminder(rows(), m[2] ?? '');
    if (!pick.ok) {
      await say(inbound, pick.error, { quote: true });
      return;
    }
    store.deleteRoutine(scope, pick.routine.name);
    routineRunner.sync();
    await say(inbound, `Borrado: ${reminderText(pick.routine)}.`, { quote: true });
  };

  /** /tv <orden>: orden simple a la tele sin pasar por el modelo (solo el dueño, en privado). */
  let tvChatTool: ReturnType<typeof createTvTool> | undefined;
  // Doble toque en el mando /tv (o Telegram entregando dos veces): misma orden una vez.
  const tvPressGuard = createTvPressGuard();
  const runTvOrder = async (text: string): Promise<string> => {
    tvChatTool ??= createTvTool(tvToolDeps(store));
    const res = await tvChatTool.execute('tv-chat', { action: 'command', text });
    return res.content
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join(' ')
      .trim();
  };
  const cmdTv = async (inbound: Inbound, args: string): Promise<void> => {
    const isOwner = isOwnerDm(inbound, vigilanteOwnerId);
    const stale = args.trim() ? staleTvOrderNotice(inbound.sentAt) : null;
    if (stale) {
      await say(inbound, stale, { quote: true });
      return;
    }
    // /tv a secas, del dueño en privado: el mando con botones.
    if (!args.trim() && isOwner) {
      await say(inbound, TV_BUTTONS_TITLE, { quote: true, buttons: tvButtons() });
      return;
    }
    const reply = await tvChatCommand(args, { isOwner, run: runTvOrder });
    await say(inbound, reply, { quote: true });
  };

  /** /ordenador [on|off]: interruptor de Computer Use en caliente (solo el dueño, en privado). */
  const cmdOrdenador = async (inbound: Inbound, args: string): Promise<void> => {
    const reply = computerSwitchCommand(args, {
      isOwner: isOwnerDm(inbound, vigilanteOwnerId),
      enabled: () => config.computerUse !== false,
      set: (on) => {
        config.computerUse = on;
        log.warn(`Computer Use ${on ? 'activado' : 'desactivado'} desde el chat (/ordenador)`);
      },
      save: (on) => saveComputerSwitch(paths.state, on),
      offSaved: () => computerOffSaved(paths.state),
    });
    await say(inbound, reply, { quote: true });
  };

  /** /consumo [hoy|semana|mes|N]: tokens y coste estimado por día y modelo (solo lectura). */
  const cmdConsumo = async (inbound: Inbound, args: string): Promise<void> => {
    const days = parseUsageDays(args);
    if (days === null) {
      await say(inbound, 'Uso: /consumo [hoy|semana|mes|1-31]', { quote: true });
      return;
    }
    const text = formatUsageReport(usageReport(days), { budgetEur: config.dailyBudgetEur });
    await say(inbound, text, { quote: true });
  };

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
      const day = localDay();
      logSummary = summarizeLog(readFileSync(join(paths.log, `${day}.jsonl`), 'utf8'));
    } catch {
      logSummary = null;
    }
    // Proyecto y modelo de esta conversación: solo el dueño en su chat privado.
    let conversation: string[] | undefined;
    if (isOwnerDm(inbound, vigilanteOwnerId)) {
      const thread = await resolveThread(inbound);
      conversation = conversationStatus({
        projectDir: projectContexts.get(thread.key),
        project: projectContexts.load(thread.key),
        model: thread.agent.modelId,
        primaryModel: thread.agent.availableModels[0] ?? config.model,
      });
    }
    const text = formatStatus({
      conversation,
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
    await say(inbound, marksWithTitles(text, isStatusTitle), { quote: true, format: 'marks' });
  };

  /** What the user said they would do, in the tracker's own Spanish summary. */
  const cmdFollowups = async (inbound: Inbound): Promise<void> => {
    // Solo los de este chat: un grupo no debe ver lo que Nico se apuntó en privado.
    const text = followups.safe(
      () => followups.summarize(Date.now(), { chatKey: chatKey(inbound) }),
      'No he podido leer los pendientes.',
    );
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
      // Solo los de este chat: el mismo asunto en otro chat es otra nota.
      const here = chatKey(inbound);
      const pending = followups
        .list(undefined, 500)
        .filter((f) => f.status === 'pending' && inChatScope(f.scope, here));
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
    const vigentes = () =>
      memory.allIn(memoryScopesFor(thread.key).read).filter((e) => e.supersededBy === null);
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
      const hits = memory
        .recallIn(memoryScopesFor(thread.key).read, restText)
        .filter((e) => e.supersededBy === null);
      await say(
        inbound,
        hits.length
          ? hits.map((e) => `- [${e.id}] (${e.date}) ${e.text}`).join('\n')
          : 'No hay nada guardado que coincida con eso.',
        { quote: true },
      );
      return;
    }
    if (sub === 'revisar' || sub === 'contradicciones' || sub === 'review') {
      await say(inbound, contradictionsReply(vigentes()), { quote: true });
      return;
    }
    if (sub === 'olvidar' || sub === 'borrar' || sub === 'forget') {
      if (!restText) {
        await say(inbound, 'Uso: /memoria olvidar <id> (el id sale en /memoria)', {
          quote: true,
        });
        return;
      }
      const removed = memory.forgetIn(memoryScopesFor(thread.key).read, restText);
      await say(
        inbound,
        removed ? `Olvidado ${restText}.` : `No había nada con id ${restText} en este chat.`,
        { quote: true },
      );
      return;
    }
    if (sub === 'exportar' || sub === 'export') {
      const entries = memory.allIn(memoryScopesFor(thread.key).read);
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
    await say(
      inbound,
      'Uso: /memoria [listar | buscar <texto> | revisar | olvidar <id> | exportar]',
      {
        quote: true,
      },
    );
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
    // El perfil es del dueño: listar, guardar, olvidar o exportar solo desde su
    // chat privado. Antes cualquier usuario autorizado, o un grupo, lo leía y editaba.
    if (!isOwnerDm(inbound, vigilanteOwnerId)) {
      await say(inbound, 'El perfil solo está disponible en el chat privado del dueño.', {
        quote: true,
      });
      return;
    }
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
        await say(inbound, ownerFailNote('perfil', err), { quote: true });
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
      await say(inbound, ownerFailNote('skill', err), { quote: true });
    }
  };
  const cmdSkillsSearch = async (inbound: Inbound, args: string): Promise<void> => {
    await say(inbound, await skillsSearchReply(args, process.env.PA_SKILLS_INDEX_URL), {
      quote: true,
    });
  };
  const cmdSkillsCatalog = async (inbound: Inbound): Promise<void> => {
    await say(inbound, await skillsCatalogReply(skills.list(), process.env.PA_SKILLS_CATALOG_URL), {
      quote: true,
    });
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
    // Notas de voz en el altavoz (/altavoz): la que suena se corta y la cola se vacía.
    // La respuesta que el PC dice en voz alta en la conversación por voz de este chat.
    const notes =
      altavozPlayer.clear(chatKey_) +
      stopSpokenReply({
        chatKey: chatKey_,
        sessionChatKey,
        speech: activeSpeech,
        playback: sessionPlayback,
      }) +
      stopBriefingVoice(inbound.chatId);
    log.info('stop requested', {
      chatId: inbound.chatId,
      wasActive,
      threads: mine.length,
      notes,
    });
    await say(inbound, stopReplyText(wasActive, notes), { quote: true });
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
      const note = ownerFailNote('directo', err);
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
      await telegram.sendVideo(Number(inbound.chatId), bytes, seconds, 'Camara', inbound.threadId);
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
        await telegram.sendVideo(
          Number(inbound.chatId),
          bytes,
          seconds,
          'Camara y voz',
          inbound.threadId,
        );
      } catch (err) {
        await say(inbound, ownerFailNote('camaraMicro', err), { quote: true });
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
      await say(inbound, failedReply('No he podido usar la cámara', err), { quote: true });
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
      await say(inbound, failedReply('No he podido grabar el micrófono', err), { quote: true });
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
      await say(inbound, failedReply('No he podido reproducir el audio', err), { quote: true });
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
    await say(inbound, helpText({ bold: true }), { quote: true, format: 'marks' });
  };

  /** /funciones [área]: lo que sé hacer por áreas; el dueño en privado lo ve todo. */
  const cmdFunciones = async (inbound: Inbound, args: string): Promise<void> => {
    const view = { owner: isOwnerDm(inbound, vigilanteOwnerId) };
    const area = findArea(args);
    await say(inbound, funcionesText(view, args), {
      quote: true,
      buttons: funcionesButtons(view, args.trim() ? area?.id : undefined),
    });
  };

  const cmdStart = async (inbound: Inbound): Promise<void> => {
    await say(inbound, startText(inbound.displayName), { quote: true });
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
    opts: {
      images?: Inbound['images'];
      spoken?: (text: string) => Promise<void>;
      /** Otro destino (el panel): nada del turno sale por Telegram, todo va aquí. */
      out?: TurnOutput;
      /** Turno del chat del panel (loopback + token): lo escribe el dueño, puede enseñar reglas. */
      panel?: boolean;
    },
  ): Promise<void> => {
    const generation = thread.generation;
    const out = opts.out;
    /** Lo que el turno diría aparte: por Telegram, o al panel si el turno es suyo. */
    const tell: typeof say = async (to, text, o) => {
      if (!out) return say(to, text, o);
      out.note(text);
      return null;
    };
    thread.active = true;
    // Which message this turn is answering, so a tool that sends something back can
    // quote it. Replaced per turn, because one thread serves many messages.
    threadInbound.set(thread.key, inbound);
    threadOutputs.bind(thread.key, out);
    // Taint gate (F2): a new message from the owner starts clean; what the
    // previous turn read from outside no longer blocks standing approvals.
    thread.gate.clearTaint(thread.key);
    // F10: un turno que entra por correo es contenido externo: lo que no sea lectura pregunta.
    // También privado: el cuerpo del correo es de tu buzón y entra sin herramienta.
    if (inbound.channel === EMAIL_CHANNEL) taintEmailTurn(thread.gate, thread.key);
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
    /** La nota de progreso del turno: se publica una vez y después se edita. */
    const liveProgress = new LiveNote({
      send: (text) =>
        telegram.send({
          channel: 'telegram',
          account: telegram.account,
          chatId: inbound.chatId,
          text,
        }),
      edit: (id, text) => telegram.editMessageText(inbound.chatId, id, text),
    });

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
    if (!out && wantsScreenshot(inbound.text)) {
      void sendScreenShot(inbound, 'Así está el PC ahora mismo.', thread.key).catch(
        (err: unknown) => {
          log.warn('auto screenshot failed', { err });
        },
      );
    }

    // Telegram expires the typing indicator after ~5s, so it is refreshed while a run
    // is alive. It says "working" without inventing a progress report.
    const typing = setInterval(() => {
      if (finished || out) return;
      void telegram.action(inbound.chatId, 'typing');
    }, 4000);
    typing.unref();

    const status = setInterval(() => {
      if (finished || out) return;
      // The progress note is opt-out per chat: some people want to be told how it is
      // going while it works, others want one message at the end and nothing between.
      if (statusOn.get(inbound.chatId) === false) return;
      const now = Date.now();
      if (now - startedAt > 25_000 && now - lastStatusAt > 45_000) {
        lastStatusAt = now;
        // Varied and short. A progress note that says the same three words every
        // time reads as an automated nag; this is the same information in the
        // voice of someone checking in. UNA sola nota por turno, editada: antes cada
        // 45 s salía un mensaje nuevo (y una notificación en el móvil).
        const hadNote = liveProgress.id !== null;
        void liveProgress
          .show(
            progressNote({
              elapsedMs: now - startedAt,
              summary: lastSummary,
              toolCalls: toolNames.length,
            }),
          )
          .then(() => {
            if (!hadNote && liveProgress.id) progressIds.push(liveProgress.id);
          });
      }
    }, 5000);
    status.unref();

    // Acuse inmediato de voz/foto/documento («🎙️ Transcribiendo…»), editado al
    // terminar. Respeta /estado off: quien no quiere notas de progreso tampoco este.
    const receipt = new InboundReceipt({
      send: (text) =>
        telegram.send({
          channel: 'telegram',
          account: telegram.account,
          chatId: inbound.chatId,
          threadId: inbound.threadId,
          replyToMessageId: inbound.messageId,
          text,
        }),
      edit: (id, text) => telegram.editMessageText(inbound.chatId, id, text),
    });
    const kind = receiptKind(inbound);
    if (kind && statusOn.get(inbound.chatId) !== false) {
      await receipt.start(receiptStartText(kind, inbound));
    }
    /** Acuse de foto/documento: ya leído, y se borra con las notas de progreso. */
    const settleFileReceipt = async (): Promise<void> => {
      if (!receipt.id || kind === 'voice') return;
      await receipt.update(RECEIPT_READ_TEXT);
      progressIds.push(receipt.id);
    };

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
            out.status === 'ok'
              ? docMemory.indexOcr(memoryScopesFor(thread.key).write, ref, out.text, caption)
              : null;
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
            : `[Imagen reenviada: ${label}. ${tooBigForBotDownload(inbound.documentSizeBytes) ?? 'Telegram no devolvió el archivo.'}]`;
        } else if (docMime.startsWith('audio/')) {
          const bytes = await telegram.downloadFile(inbound.documentFileId).catch(() => null);
          if (!bytes) {
            documentNote = `[Audio reenviado: ${label}. ${tooBigForBotDownload(inbound.documentSizeBytes) ?? 'Telegram no devolvió el archivo.'}]`;
          } else {
            try {
              const heard = await transcribeVoiceNote(bytes, { mimeType: docMime });
              const indexed = docMemory.indexTranscript(
                memoryScopesFor(thread.key).write,
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
              documentNote = `[Documento reenviado: ${label}. ${tooBigForBotDownload(inbound.documentSizeBytes) ?? 'Telegram no devolvió el archivo.'}]`;
            } else {
              // The thread key is the memory scope everywhere: the documents
              // tool reads with () => thread.key, so indexing MUST use the
              // same string or nothing is findable even in the same chat.
              const indexed = await docMemory.index(
                memoryScopesFor(thread.key).write,
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

      await settleFileReceipt();

      let prompt = text;
      if (inbound.audioFileId) {
        const bytes = await telegram.downloadFile(inbound.audioFileId);
        if (!bytes) {
          if (receipt.id) progressIds.push(receipt.id);
          const tooBig = tooBigForBotDownload(inbound.audioSizeBytes);
          await tell(
            inbound,
            tooBig
              ? `No he podido descargar el audio. ${tooBig}`
              : 'No he podido descargar el audio.',
            { quote: true },
          );
          return;
        }
        recall.retain(chatKey(inbound), inbound.messageId, bytes);
        await telegram.action(inbound.chatId, 'typing');
        try {
          const heard = await transcribeVoiceNote(bytes, { mimeType: inbound.audioMimeType });
          // Marked as a transcription so the model does not treat a misheard word as
          // something the user typed, and so the reply can be spoken back.
          prompt = `[Nota de voz transcrita${heard.truncated ? ' (audio largo: solo los primeros 15 minutos)' : ''}] ${heard.text}`;
          // El acuse queda con lo entendido: si oyó mal, se ve antes de la respuesta.
          await receipt.update(voiceHeardText(heard.text));
          log.info('voice transcribed', {
            seconds: heard.durationSeconds,
            chars: heard.text.length,
          });
          // Remembered with the handle, so "suéltame ese audio" two messages later
          // has something to act on.
          recall.setTranscript(chatKey(inbound), inbound.messageId, heard.text);
          try {
            docMemory.indexTranscript(
              memoryScopesFor(thread.key).write,
              inbound.messageId,
              heard.text,
              inbound.text,
            );
          } catch (err) {
            // The transcript is already in the turn and in the short-term recall;
            // losing only its long-term index must not kill the turn.
            log.warn('transcript index failed', { err });
          }
        } catch (err) {
          if (receipt.id) progressIds.push(receipt.id);
          await tell(inbound, failedReply('No he entendido la nota de voz', err), { quote: true });
          return;
        }
      }

      rememberUserRequest(thread, prompt);
      if (documentNote) prompt = prompt.trim() ? `${documentNote}\n${prompt}` : documentNote;

      if (!prompt.trim() && !images?.length) {
        await tell(inbound, 'No he visto texto ni imagen en ese mensaje.', { quote: true });
        return;
      }

      // Memory and routines are injected as a system message, so they read as
      // standing context rather than as something the user just said.
      // Aprender de correcciones (PA_LEARN_CORRECTIONS): solo el texto del dueño, en
      // su chat privado, activa la instrucción; nunca una web, un correo o una herramienta.
      const learnHint = correctionHint({
        enabled: learnCorrectionsEnabled(),
        ownerDm: isOwnerDm(inbound, vigilanteOwnerId),
        // El panel solo lo usa el dueño (loopback + token) y siempre en su hilo principal.
        panelOwner: opts.panel === true && opts.out !== undefined && thread.name === 'main',
        ownerText: text,
      });
      const contextNote = buildContextNote(
        thread,
        store,
        memory,
        snapshot,
        workstreams,
        skills,
        sessions,
        ownerProfile,
        prompt,
        isOwnerDm(inboundFor(thread), vigilanteOwnerId),
        projectContexts,
      );
      thread.agent.attachContext(learnHint ? `${contextNote}\n\n${learnHint}` : contextNote);

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

      // La marca [[aprendido: …]] nunca llega al dueño; si vale, se guarda la regla en la
      // memoria del chat y la respuesta lleva una línea «📝 Aprendido: …» (sin aprobación).
      const learnt = learnFromTurn({
        memory,
        scope: memoryScopesFor(thread.key).write,
        reply: result.text,
        hinted: learnHint !== null,
        tainted: thread.gate.taintOf(thread.key) !== null,
        // «(/olvida N para borrarla)» solo donde /olvida existe (Telegram y el panel).
        forgetScopes:
          opts.out && opts.panel !== true ? undefined : memoryScopesFor(thread.key).read,
      });
      if (learnt.outcome)
        log.info('correction learned', { thread: thread.name, status: learnt.outcome.status });
      if (learnt.text !== result.text || learnt.line) {
        result = {
          ...result,
          text: learnt.line ? `${learnt.text}\n\n${learnt.line}`.trim() : learnt.text,
        };
      }

      // Learn from this run's problems: a tool failed and another way then worked.
      // Built from the structured trail only, saved straight into `lecciones`.
      const learnDay = localDay();
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
      // El modelo real de esta conversación (/modelo) y sus precios: PA_PRICE_*
      // solo valen para PA_MODEL.
      const usedModel = thread.agent.modelId;
      recordUsage({
        sessionId: thread.key,
        model: usedModel,
        priceOverrides: usedModel === config.model,
        inputTokens: result.inputTokens ?? 0,
        outputTokens: result.outputTokens ?? 0,
        kind: 'turn',
      });
      if (config.dailyBudgetEur > 0 && dailyBudgetExceeded(config.dailyBudgetEur)) {
        const budgetDay = localDay();
        if (budgetWarnedDay !== budgetDay) {
          budgetWarnedDay = budgetDay;
          void tell(inbound, 'Aviso: has alcanzado el presupuesto diario configurado.', {
            quote: true,
          }).catch(() => {});
        }
      }

      const text2 =
        result.text.trim() || (result.error ? `Fallo: ${result.error}` : 'Sin respuesta.');
      if (out) out.answer(text2);
      else await answer(thread, inbound, text2);
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
          if (nudgeTracker.record(nudge.suggestion, localDay())) {
            const first = nudge.suggestion.indexOf('"');
            const last = nudge.suggestion.lastIndexOf('"');
            const clause =
              first >= 0 && last > first ? nudge.suggestion.slice(first + 1, last) : '';
            // Solo el dueño, en su chat privado, alimenta su perfil: una frase de
            // otro usuario o de un grupo no puede acabar en el PERFIL.md de Nico.
            if (clause && !looksLikeCredential(clause) && isOwnerDm(inbound, vigilanteOwnerId)) {
              const saved = snapshot.appendEntry(`[auto] ${clause}`);
              if (saved.ok) autosaved = true;
            }
          }
        } catch (err) {
          log.warn('profile autosave failed', { err: String(err) });
        }
        if (autosaved) {
          log.info('profile autosaved', { thread: thread.name });
          await tell(
            inbound,
            'Lo he apuntado en tu perfil (lo repites a menudo). Si no quieres que lo recuerde, dímelo y lo borro.',
            { quote: true },
          ).catch(() => {});
        } else {
          await tell(inbound, nudge.suggestion, { quote: true }).catch(() => {});
        }
      }

      // A promise with a date attached is a follow-up, not just a fact: "voy a
      // pagar el seguro el viernes" is something to mention on Friday.
      // Hablar otra vez de algo pendiente reinicia su reloj de «llevas N d sin tocar».
      safeRemember(() => followups.touchMentioned(chatKey(inbound), inbound.text));
      const promised = followupFromMessage(inbound.text);
      if (promised) {
        safeRemember(() => followups.track(thread.key, 'date', promised.subject, promised.dueAt));
      }
    } catch (err) {
      log.error('turn threw', { thread: thread.name, err });
      await tell(inbound, friendlyError(err, 'Algo falló: '), { quote: true });
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
      purchaseApprovals.forgetThread(thread.key);
      threadOutputs.release(thread.key, out);
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
  /** Chat dueño de la conversación por voz abierta (para que /stop solo corte la suya). */
  let sessionChatKey: string | null = null;
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
      onUtterance: (heard): Promise<void> =>
        voiceUtteranceTurn(chat, heard, {
          account: telegram.account,
          nextN: () => ++wakeCount,
          getThread: (key) => getOrCreateThread(key, 'main', 'principal'),
          linkMessage: (dedupKey, threadKey) => messageThread.set(dedupKey, threadKey),
          logUtterance: (fields) => log.info('voice session utterance', fields),
          enqueue,
          runTurn,
          speak: (answer: string): Promise<void> => speakAloud(answer, created),
        }),
      onClose: (reason, detail) => {
        if (session === created) {
          session = null;
          sessionChatKey = null;
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
    sessionChatKey = chat.key;
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
          `${failedReply(`He dejado de escuchar "${wakeWord}"`, err).replace(/\.?$/, '.')} Vuelve a activarlo con /wake on.`,
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
      dedupeFile: join(paths.state, 'alerts-seen.json'),
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
    if ((args.trim().split(/\s+/)[0] ?? '').toLowerCase() === 'lista') {
      // Solo lectura: herramienta, dónde vale y desde cuándo; sin botones.
      await say(inbound, permisosListaReply(gates, approvalsDb, chatKey(inbound)), { quote: true });
      return;
    }
    await say(inbound, runPermisosCommand(gates, approvalsDb, args, chatKey(inbound)), {
      quote: true,
    });
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
      await say(inbound, failedReply('No he podido abrir el micrófono', err), { quote: true });
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
        failedReply(`No he podido ${next ? 'activar' : 'desactivar'} la palabra`, err),
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

  // Comandos de Telegram: cada uno es una entrada (nombre y alias → handler).
  // Un comando nuevo se añade aquí con una línea; un nombre repetido hace fallar
  // test/daemon-commands.test.ts (y el arranque), en vez de quedar tapado.
  const commandTable = buildCommandTable<Inbound>([
    { names: ['stop'], run: (inbound) => cmdStop(inbound) },
    { names: ['screen'], run: (inbound, args) => cmdScreen(inbound, args) },
    {
      names: ['camera', 'play', 'suena', 'toca', 'escucha', 'mic', 'micro', 'watch'],
      run: async (inbound, args, name) => {
        if (!desktop) return say(inbound, DESKTOP_OFF_MESSAGE, { quote: true }).then(() => {});
        if (name === 'camera') return cmdCamera(inbound, args);
        if (name === 'mic' || name === 'micro') return cmdMic(inbound, args);
        if (name === 'watch') return cmdWatch(inbound, args);
        return cmdPlay(inbound, args);
      },
    },
    { names: ['topic'], run: (inbound, args) => cmdTopic(inbound, args) },
    { names: ['topics'], run: (inbound) => cmdTopics(inbound) },
    { names: ['routines'], run: (inbound) => cmdRoutines(inbound) },
    {
      names: ['routine'],
      run: async (inbound, args) => cmdRoutine(await resolveThread(inbound), inbound, args),
    },
    {
      names: ['cron'],
      run: async (inbound, args) => cmdCron(await resolveThread(inbound), inbound, args),
    },
    {
      names: ['disparador', 'trigger'],
      run: async (inbound, args) => cmdTrigger(await resolveThread(inbound), inbound, args),
    },
    {
      names: ['disparadores', 'triggers'],
      run: (inbound) => {
        const chatKey_ = chatKey(inbound);
        return say(
          inbound,
          formatTriggerList(store.listTriggers().filter((t) => inChatScope(t.scope, chatKey_))),
          { quote: true },
        );
      },
    },
    {
      names: ['learn'],
      run: async (inbound, args) => cmdLearn(await resolveThread(inbound), inbound, args),
    },
    { names: ['memory'], run: (inbound) => cmdMemory(inbound) },
    {
      names: ['deshacer', 'undo'],
      run: (inbound) => say(inbound, undoLast(), { quote: true }).then(() => {}),
    },
    { names: ['steer', 'corrige'], run: (inbound, args) => cmdSteer(inbound, args) },
    { names: ['pendientes', 'followups'], run: (inbound) => cmdFollowups(inbound) },
    { names: ['entreno_hoy'], run: (inbound) => cmdGym(inbound, 'hoy') },
    { names: ['ultimo'], run: (inbound) => cmdGym(inbound, 'ultimo') },
    { names: ['peso'], run: (inbound) => cmdGym(inbound, 'peso') },
    { names: ['resumen'], run: (inbound, args) => cmdResumen(inbound, args) },
    { names: ['evolucion'], run: (inbound, args) => cmdEvolucion(inbound, args) },
    { names: ['estado'], run: (inbound) => cmdEstado(inbound) },
    {
      names: ['actualizacion'],
      run: async (inbound) => {
        const { autoupdateStatusLine } = await import('./autoupdate-cli.js');
        await say(inbound, autoupdateStatusLine(paths.state));
      },
    },
    { names: ['reintentar'], run: (inbound) => cmdReintentar(inbound) },
    { names: ['compactar'], run: (inbound) => cmdCompactar(inbound) },
    { names: ['modelo'], run: (inbound, args) => cmdModelo(inbound, args) },
    { names: ['proyecto'], run: (inbound, args) => cmdProyecto(inbound, args) },
    { names: ['altavoz'], run: (inbound, args) => cmdAltavoz(inbound, args) },
    { names: ['borrar_chat'], run: (inbound) => cmdBorrarChat(inbound) },
    {
      names: ['recordatorios', 'reminders'],
      run: (inbound, args) => cmdRecordatorios(inbound, args),
    },
    { names: ['tv'], run: (inbound, args) => cmdTv(inbound, args) },
    { names: ['ordenador'], run: (inbound, args) => cmdOrdenador(inbound, args) },
    { names: ['consumo', 'uso'], run: (inbound, args) => cmdConsumo(inbound, args) },
    {
      names: ['servicios'],
      run: (inbound) => say(inbound, formatServicesList(adoptedServices.list()), { quote: true }),
    },
    {
      // /mcp recursos|prompts: solo lectura y solo el dueño en privado.
      names: ['mcp'],
      run: async (inbound, args) => {
        if (!isOwnerDm(inbound, vigilanteOwnerId)) {
          await say(inbound, 'Este comando solo funciona en el chat privado del dueño.', {
            quote: true,
          });
          return;
        }
        await say(inbound, await mcpCommandText(args), { quote: true });
      },
    },
    { names: ['vigila'], run: (inbound, args) => cmdVigila(inbound, args) },
    { names: ['vigilando'], run: (inbound) => cmdVigilando(inbound) },
    { names: ['vigilancias'], run: (inbound) => cmdVigilancias(inbound) },
    { names: ['dejar_de_vigilar'], run: (inbound, args) => cmdDejarDeVigilar(inbound, args) },
    { names: ['precio'], run: (inbound, args) => cmdPrecio(inbound, args) },
    { names: ['compara'], run: (inbound, args) => cmdCompara(inbound, args) },
    { names: ['investiga'], run: (inbound, args) => cmdInvestiga(inbound, args) },
    { names: ['resolver', 'resolve'], run: (inbound, args) => cmdResolve(inbound, args) },
    {
      names: ['buscar', 'search'],
      run: async (inbound, args) => cmdSearch(await resolveThread(inbound), inbound, args),
    },
    {
      names: ['memoria'],
      run: async (inbound, args) => cmdMemoria(await resolveThread(inbound), inbound, args),
    },
    {
      // Reglas aprendidas de tus correcciones (PA_LEARN_CORRECTIONS): ver y borrar.
      // /olvida es un comando escrito, nunca un botón de un toque.
      names: ['aprendido', 'aprendidas'],
      run: async (inbound) => {
        const thread = await resolveThread(inbound);
        const rules = learnedRules(memory, memoryScopesFor(thread.key).read);
        await say(inbound, formatLearnedRules(rules), { quote: true });
      },
    },
    {
      names: ['olvida'],
      run: async (inbound, args) => {
        const thread = await resolveThread(inbound);
        const reply = forgetLearnedRule(memory, memoryScopesFor(thread.key).read, args);
        await say(inbound, reply, { quote: true });
      },
    },
    {
      names: ['exportar'],
      run: async (inbound, args) => cmdExportar(await resolveThread(inbound), inbound, args),
    },
    { names: ['calendario'], run: (inbound, args) => cmdCalendario(inbound, args) },
    { names: ['perfil'], run: (inbound, args) => cmdPerfil(inbound, args) },
    {
      names: ['skills'],
      run: (inbound, args) => {
        const sub = args.trim().split(/\s+/)[0]?.toLowerCase();
        if (sub === 'instalar' || sub === 'importar' || sub === 'install') {
          return cmdSkillsImport(inbound, args.trim().split(/\s+/).slice(1).join(' '));
        }
        if (sub === 'buscar' || sub === 'search') {
          return cmdSkillsSearch(inbound, args.trim().split(/\s+/).slice(1).join(' '));
        }
        if (sub === 'catalogo' || sub === 'catálogo' || sub === 'catalog') {
          return cmdSkillsCatalog(inbound);
        }
        return say(
          inbound,
          'Uso: /skills buscar <texto> · /skills catalogo · /skills instalar <url de SKILL.md>',
          { quote: true },
        );
      },
    },
    { names: ['agenda'], run: (inbound, args) => cmdAgenda(inbound, args) },
    { names: ['correo'], run: (inbound, args) => cmdCorreo(inbound, args) },
    { names: ['ocr'], run: (inbound, args) => cmdOcr(inbound, args) },
    { names: ['ojo'], run: (inbound, args) => cmdOjo(inbound, args) },
    { names: ['permisos'], run: (inbound, args) => cmdPermisos(inbound, args) },
    { names: ['ignora'], run: (inbound, args) => cmdIgnora(inbound, args) },
    { names: ['ignorados'], run: (inbound, args) => cmdIgnorados(inbound, args) },
    { names: ['avisos'], run: (inbound, args) => cmdAvisos(inbound, args) },
    { names: ['voice'], run: (inbound, args) => cmdVoice(inbound, args) },
    { names: ['conversacion'], run: (inbound, args) => cmdConversacion(inbound, args) },
    { names: ['wake', 'asistenta'], run: (inbound, args) => cmdWake(inbound, args) },
    { names: ['status'], run: (inbound, args) => cmdStatus(inbound, args) },
    { names: ['start'], run: (inbound) => cmdStart(inbound) },
    { names: ['funciones'], run: (inbound, args) => cmdFunciones(inbound, args) },
    { names: ['help'], run: (inbound) => cmdHelp(inbound) },
  ]);

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
    onFuncionesButton: async (press) => {
      const view = { owner: isOwnerDm(press, vigilanteOwnerId) };
      return {
        text: funcionesButtonText(press.data, view),
        buttons: funcionesButtons(
          view,
          findArea(press.data.slice(FUNCIONES_CALLBACK_PREFIX.length))?.id,
        ),
      };
    },
    onTvButton: (press) =>
      tvButtonCommand(press.data, {
        isOwner: isOwnerDm(press, vigilanteOwnerId),
        run: runTvOrder,
        guard: tvPressGuard,
        chatId: press.chatId,
      }),
    onMessage: async (inbound) => {
      if (!inbound.authorised) return;
      await withInboundFailureReply(
        async () => {
          const chatKey_ = chatKey(inbound);
          const started = beginInbound(inbound, chatKey_, {
            seen: seenMessages,
            log,
            emitMessageTrigger: (scope, text) =>
              triggerEngine.emit({ type: 'mensaje', scope, text }),
            setLastChat: (chat) => {
              lastChat = chat;
            },
            recordAudio: (key, audio) => {
              recall.record(key, audio);
            },
          });
          if (!started) return;
          const { dedupKey } = started;

          // Altavoz: la nota suena sola en el PC/la tele, sin esperar al modelo.
          routeInboundToAltavoz(inbound, {
            mode: altavoz.get(chatKey_),
            desktop,
            ownerUserId: vigilanteOwnerId,
            player: altavozPlayer,
            download: (fileId) => telegram.downloadFile(fileId, 25_000_000),
            reply: (text) => {
              void say(inbound, text, { quote: true });
            },
            key: chatKey_,
          });

          // Correo, confirmación de /borrar_chat y comandos: antes de cualquier hilo.
          const control = await routeInboundControl(inbound, chatKey_, {
            mailReply: (m) => cmdCorreo(m, m.text),
            consumeErase: (key, text) => eraseConfirm.consume(key, text),
            eraseConfirmed: (m) => cmdBorrarChatConfirmado(m),
            eraseCancelled: (m) => say(m, 'Cancelado: no he borrado nada.', { quote: true }),
            parseCommand,
            // Commands bypass the agent entirely: they are the user's hands on the
            // machine, not a task to delegate, and they must work even when every thread
            // is busy or the provider is down.
            runCommand: (m, command) =>
              dispatchCommand(commandTable, m, command, async (name) => {
                // Unknown slash command: say so instead of silently running it as a task.
                await say(m, `No conozco el comando /${name}. /help para ver la lista.`, {
                  quote: true,
                });
              }),
          });
          if (control === 'handled') return;

          const thread = await resolveThread(inbound);
          messageThread.set(dedupKey, thread.key);
          // "Dime más"/"sigue": sirve la respuesta completa cacheada sin gastar un turno.
          const full = cachedFullReply(inbound, thread.key, { isMoreRequest, takeFullReply });
          if (full) {
            // Antes salía el markdown crudo del modelo (### y tablas con |).
            // Cada trozo apunta al hilo: responder al texto completo sigue esta conversación.
            await say(inbound, cleanForTelegram(stripVoicePrefix(full), { keepMarks: true }), {
              format: 'marks',
              onSent: threadForSentIds(messageThread, chatKey(inbound), thread.key),
            });
            return;
          }
          // Serialise inside the thread only. Different threads run concurrently; the
          // machine mutex inside the tools is what keeps them from colliding.
          void queueThreadTurn(thread, async () => {
            lastTurns.remember(thread.key, {
              text: inbound.text,
              images: inbound.images,
              agent: thread.agent,
              mark: thread.agent.messages.length,
              compactions: thread.agent.compactions,
            });
            await runTurn(thread, inbound, inbound.text, {});
          });
        },
        (message) => say(inbound, message, { quote: true }),
        (error) => log.error('inbound message failed', { error: startupFailureMessage(error) }),
      );
    },
    log: (level, msg, fields) => log[level](msg, fields ?? {}),
  });

  // F3: webhook local para lanzar una rutina (apagado por defecto; docs/webhook.md).
  const hookCfg = webhookConfig();
  if (hookCfg && 'error' in hookCfg) {
    log.warn('webhook not started', { reason: hookCfg.error });
  } else if (hookCfg) {
    try {
      const hook = await startWebhookServer({
        ...hookCfg,
        trigger: async (name) => {
          const matches = routineRunner.status().filter((st) => st.name === name);
          const st = matches[0];
          if (!st)
            return { status: 404, message: `no hay ninguna rutina programada llamada "${name}"` };
          if (matches.length > 1) {
            return { status: 409, message: `hay varias rutinas "${name}" en chats distintos` };
          }
          const routine = store.getRoutine(st.scope, st.name);
          if (!routine?.enabled)
            return { status: 409, message: `la rutina "${name}" está en pausa` };
          if (routineRunner.isRunning(st.scope, st.name)) {
            return { status: 409, message: `la rutina "${name}" ya se está ejecutando` };
          }
          void routineRunner.fire(st.scope, st.name);
          return { status: 202, message: `lanzada "${name}"` };
        },
        log: (msg, fields) => log.info(msg, fields ?? {}),
      });
      log.info('webhook listening', { host: '127.0.0.1', port: hook.port });
    } catch (err) {
      log.warn('webhook not started', { err: String(err) });
    }
  }

  log.info('daemon ready', { allowed, threads: threads.size });

  // Arranque: una sola línea clara en la consola y el aviso «Asistenta lista ✅» al
  // chat privado del dueño (como mucho uno cada 10 min; PA_BOOT_NOTICE=0 lo apaga).
  void (async () => {
    const facts = {
      model: config.model,
      tv: Boolean(await vaultGet('tv:host').catch(() => undefined)),
      computerUse: desktop && config.computerUse !== false,
      mail: await mailStatus()
        .then((m) => m.read === 'ok')
        .catch(() => false),
      threads: threads.size,
    };
    process.stdout.write(`${bootBanner(facts)}\n`);
    const result = await maybeSendBootNotice({
      statePath: join(paths.state, BOOT_NOTICE_FILE),
      ownerChatId: vigilanteOwnerId,
      facts,
      send: (chatId, text) =>
        say(
          {
            channel: 'telegram',
            account: telegram.account,
            chatId,
            userId: chatId,
            text: '',
            authorised: true,
            messageId: 'boot-notice',
            receivedAt: new Date().toISOString(),
          },
          text,
          { quote: false },
        ),
    });
    if (result !== 'off') log.info('boot notice', { result });
  })().catch(() => {});

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
          failedReply(`No he podido escuchar la palabra "${wakeWord}"`, err),
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

/**
 * The four preference words the instinct category was designed for. Broader
 * matching would record noise as instinct and dilute the confidence counts.
 */
const PREFERENCE_MARKERS = /\b(prefiero|me gusta\w*|siempre|nunca)\b/iu;

/** Ventana de la agenda del vigilante: las caducidades avisan a 30 días. */
const VIGILANTE_AGENDA_DAYS = 35;

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
  if (!nudge.worth || !hasDateSignal(text)) return null;
  // The clause the nudge already quoted is the best subject: it is what the user
  // will recognise in /pendientes.
  const first = nudge.suggestion.indexOf('"');
  const last = nudge.suggestion.lastIndexOf('"');
  const quoted = first >= 0 && last > first ? nudge.suggestion.slice(first + 1, last) : '';
  const subject = (quoted || text.trim()).replace(/\s+/g, ' ').slice(0, 160);
  return { subject, dueAt: estimateDueAt(text, now) };
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
  const entries = memory.allIn(memoryScopesFor(scope).read);
  const scopes = memory.scopes();
  return entries.length
    ? [`Recuerdo ${entries.length} cosas:`, ...entries.map((e) => `- [${e.id}] ${e.text}`)].join(
        '\n',
      )
    : `No recuerdo nada todavía. Lo aprenderé sobre la marcha. (${scopes.length} conversaciones con memoria)`;
}

/**
 * /vigilando: las páginas vigiladas del chat, con cabecera «Páginas vigiladas: N»
 * (en negrita en Telegram vía isWatchListTitle; el resto es texto del usuario).
 */
/**
 * /vigilando: un botón «🗑 Dejar de vigilar …» por página (hasta 8), que equivale a
 * escribir /dejar_de_vigilar <id>. Sin páginas, sin botones.
 */
/**
 * /cron (lista): un botón por rutina programada (hasta 8), «⏸ Pausar …» si está
 * activa y «▶️ Reanudar …» si está en pausa; equivalen a escribir /cron pausa|reanudar
 * <nombre>. Borrar no tiene botón: sigue pidiendo escribirlo.
 */
/**
 * Aviso de un recordatorio: «✅ Hecho» (lo da por visto), «⏰ +1h» (otro igual dentro
 * de una hora) y «🌅 Mañana 9:00» (otro igual mañana a las 9). Ninguno borra nada. `id` es el de FiredReminders.
 */
export function reminderButtons(id: string): Array<{ label: string; action: string }> | undefined {
  const buttons = [
    commandButton('✅ Hecho', 'recordatorios', id, 'hecho'),
    commandButton('⏰ +1h', 'recordatorios', id, 'pospone'),
    commandButton('🌅 Mañana 9:00', 'recordatorios', id, 'manana'),
  ].filter((x): x is { label: string; action: string } => x !== undefined);
  return buttons.length ? buttons : undefined;
}

/**
 * /compara: «👀 Vigilar» equivale a /vigila <ese enlace>. El botón lleva el id corto de
 * CompareWatchLinks, nunca el enlace.
 */
export function compareWatchButtons(
  id: string,
  target?: { id: string; cents: number },
): Array<{ label: string; action: string }> | undefined {
  const b = [
    commandButton('👀 Vigilar', 'vigila', id, 'enlace'),
    target
      ? commandButton(`🎯 Avisar si baja a ${eur(target.cents)}`, 'vigila', target.id, 'enlace')
      : undefined,
  ].filter((x): x is { label: string; action: string } => x !== undefined);
  return b.length ? b : undefined;
}

/**
 * Segundo botón de /compara: vigilar la ficha con objetivo = el mejor precio hallado en
 * otra tienda (suggestedTargetCents). Devuelve [] si no hay objetivo que proponer.
 */
export function compareTargetButton(
  report: CompareReport,
  remember: (targetCents: number) => string,
): [] | [{ id: string; cents: number }] {
  const cents = suggestedTargetCents(report);
  return cents === undefined ? [] : [{ id: remember(cents), cents }];
}

/** Hora corta de Madrid para «no te aviso hasta …». */
function fmtMuteUntil(ms: number): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    weekday: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(ms);
}

/** `/vigila silenciar <id>` (botón «🔕 Silenciar 1 día») y `/vigila avisar <id>`. */
export function vigilaSilenceArgs(
  raw: string,
): { action: 'silenciar' | 'avisar'; id: string } | null {
  const m = /^(silenciar|avisar) ([A-Za-z0-9_-]{1,40})$/.exec(raw.trim());
  if (!m?.[1] || !m[2]) return null;
  return { action: m[1] as 'silenciar' | 'avisar', id: m[2] };
}

/**
 * Respuesta a `/vigila silenciar|avisar <id>`. Tras silenciar lleva «🔔 Avisar otra vez»
 * (= `/vigila avisar <id>`) y tras avisar otra vez «🔕 Silenciar 1 día»: ninguno borra nada.
 */
export function vigilaSilenceReply(
  action: 'silenciar' | 'avisar',
  w: { id: string; label: string; url: string; mutedUntil: number } | null | undefined,
): { text: string; buttons: Array<{ label: string; action: string }> } {
  if (!w)
    return { text: 'No encuentro esa vigilancia en este chat. Mira /vigilando.', buttons: [] };
  const name = w.label || w.url;
  if (action === 'avisar') {
    const mute = commandButton('🔕 Silenciar 1 día', 'vigila', w.id, 'silenciar');
    return { text: `🔔 Vuelvo a avisarte de ${name}.`, buttons: mute ? [mute] : [] };
  }
  const again = commandButton('🔔 Avisar otra vez', 'vigila', w.id, 'avisar');
  return {
    text: `🔕 Silenciada 1 día: ${name}. Sigo leyendo el precio, pero no te aviso hasta ${fmtMuteUntil(w.mutedUntil)}. Para quitarlo antes: /vigila avisar ${w.id}`,
    buttons: again ? [again] : [],
  };
}

/** `/precio silenciar|avisar <clave>`: botones de un aviso del vigilante de precios. */
export function precioMuteArgs(
  raw: string,
): { action: 'silenciar' | 'avisar'; key: string } | null {
  const m = /^(silenciar|avisar) ([0-9a-f]{8})$/.exec(raw.trim());
  if (!m?.[1] || !m[2]) return null;
  return { action: m[1] as 'silenciar' | 'avisar', key: m[2] };
}

/** «🔕 Silenciar 1 día» de un aviso de posible error de precio (= /precio silenciar <clave>). */
export function pricewatchMuteButtons(key: string): Array<{ label: string; action: string }> {
  const b = commandButton('🔕 Silenciar 1 día', 'precio', key, 'silenciar');
  return b ? [b] : [];
}

/** Respuesta a /precio silenciar|avisar; ofrece el contrario («🔔 Avisar otra vez» / «🔕 Silenciar 1 día»). */
export function pricewatchMuteReply(
  action: 'silenciar' | 'avisar',
  key: string,
  hit: { product: string; until: number } | null,
): { text: string; buttons: Array<{ label: string; action: string }> } {
  if (!hit) {
    return {
      text:
        action === 'silenciar'
          ? 'No encuentro ese aviso de precio.'
          : 'Ese producto no estaba silenciado.',
      buttons: [],
    };
  }
  if (action === 'avisar')
    return { text: `🔔 Vuelvo a avisarte de ${hit.product}.`, buttons: pricewatchMuteButtons(key) };
  const again = commandButton('🔔 Avisar otra vez', 'precio', key, 'avisar');
  return {
    text: `🔕 Silenciado 1 día: ${hit.product}. Sigo leyendo el precio, pero no te aviso de posibles errores de precio hasta ${fmtMuteUntil(hit.until)}. Para quitarlo antes: /precio avisar ${key}`,
    buttons: again ? [again] : [],
  };
}

/**
 * Respuesta de «no he podido …» para el chat: conserva un error ya en castellano, dice claro
 * si falta un programa en el PC y nunca pega salida técnica (ffmpeg, rutas, JSON, pilas).
 */
/** Qué no se pudo hacer, por sitio de cli.ts que antes pegaba err.message crudo. */
export const OWNER_FAIL_WHAT = {
  clip: 'No he podido grabar el clip',
  perfil: 'No lo he guardado',
  skill: 'No he podido instalarla',
  directo: 'No he podido abrir la vista en directo',
  camaraMicro: 'No he podido grabar cámara y micrófono',
} as const;

/** Aviso al dueño en castellano: conserva motivos en castellano, oculta texto técnico. */
export function ownerFailNote(kind: keyof typeof OWNER_FAIL_WHAT, err: unknown): string {
  return failedReply(OWNER_FAIL_WHAT[kind], err);
}

export function failedReply(what: string, err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const missing = /\bspawn (\S+) ENOENT\b/.exec(raw)?.[1];
  if (missing) return `${what}: no encuentro «${missing.split(/[\\/]/).pop()}» instalado en el PC.`;
  const friendly = friendlyError(err, `${what}: `);
  if (friendly.startsWith(`${what}: `)) return friendly;
  if (/^(?:Algo ha fallado|Se me ha roto algo)/.test(friendly)) {
    return `${what} (error interno). Prueba otra vez; si se repite, mira /estado.`;
  }
  return `${what}. ${friendly}`;
}

/** Aviso al dueño cuando falla la copia de seguridad diaria: motivo en castellano, sin texto técnico. */
export function backupFailedNotice(err: unknown): string {
  const base = 'No he podido hacer la copia de seguridad de hoy';
  const retry = 'Lo reintento en unos minutos.';
  const code = (err as { code?: unknown } | null)?.code;
  const probe = `${err instanceof Error ? err.message : String(err ?? '')} ${typeof code === 'string' ? code : ''}`;
  if (/\bENOSPC\b/.test(probe))
    return `${base}: el disco está lleno. Libera espacio; lo reintento en unos minutos.`;
  if (/\b(?:EACCES|EPERM)\b/.test(probe)) {
    return `${base}: no tengo permiso para escribir en la carpeta de copias. ${retry}`;
  }
  if (/\bEBUSY\b/.test(probe)) return `${base}: había un archivo en uso. ${retry}`;
  const friendly = failedReply(base, err);
  if (friendly.startsWith(`${base}: `)) return `${friendly.replace(/\.?$/, '.')} ${retry}`;
  return `${base} (detalles en el registro). ${retry}`;
}

const PAGE_ALERT_KINDS: ReadonlySet<CheckOutcome['kind']> = new Set(['changed', 'target', 'drop']);

/**
 * Aviso de una página vigilada, o null si no hay nada que decir o está silenciada
 * («🔕 Silenciar 1 día»). Los avisos de precio llevan ese botón: no borra nada, solo
 * calla esta página 24 h (y /vigila avisar <id> lo deshace).
 */
export function pageNotice(
  w: PageWatch,
  outcome: CheckOutcome,
  now: number,
): { text: string; buttons: Array<{ label: string; action: string }> } | null {
  const text = describeChange(w, outcome);
  if (!text || w.mutedUntil > now) return null;
  const mute = PAGE_ALERT_KINDS.has(outcome.kind)
    ? commandButton('🔕 Silenciar 1 día', 'vigila', w.id, 'silenciar')
    : undefined;
  return { text, buttons: mute ? [mute] : [] };
}

/** Lo que equivale a escribir: «/vigila <enlace>» o «/vigila <enlace> objetivo=12,34€». */
export function vigilaArgsFromCompare(hit: { url: string; targetCents?: number }): string {
  if (hit.targetCents === undefined) return hit.url;
  const euros = Math.floor(hit.targetCents / 100);
  const cents = String(hit.targetCents % 100).padStart(2, '0');
  return `${hit.url} objetivo=${euros},${cents}€`;
}

export function cronListButtons(
  list: ReadonlyArray<{ name: string; kind: string; schedule?: string | null; enabled: boolean }>,
): Array<{ label: string; action: string }> | undefined {
  const buttons = list
    .filter((r) => r.kind === 'schedule' && r.schedule)
    .slice(0, 8)
    .map((r) =>
      r.enabled
        ? commandButton(`⏸ Pausar ${r.name}`, 'cron', r.name, 'pausa')
        : commandButton(`▶️ Reanudar ${r.name}`, 'cron', r.name, 'reanudar'),
    )
    .filter((b): b is { label: string; action: string } => b !== undefined);
  return buttons.length ? buttons : undefined;
}

export function watchStopButtons(
  list: ReadonlyArray<{ id: string; label: string; url: string }>,
): Array<{ label: string; action: string }> | undefined {
  const buttons = list
    .slice(0, 8)
    .map((w) => commandButton(`🗑 Dejar de vigilar ${w.label || w.url}`, 'dejar_de_vigilar', w.id))
    .filter((b): b is { label: string; action: string } => b !== undefined);
  return buttons.length ? buttons : undefined;
}

/**
 * /vigilando: por página, «📈 Precio …» (enseña su ficha, como /precio <id>) y al lado
 * «🗑 Dejar de vigilar …»; cada pareja va en su propia fila del teclado.
 */
export function watchListButtons(
  list: ReadonlyArray<{ id: string; label: string; url: string }>,
): Array<{ label: string; action: string }> | undefined {
  const buttons = (watchStopButtons(list) ?? []).flatMap((stop) => {
    const id = stop.action.slice(stop.action.lastIndexOf(' ') + 1);
    const w = list.find((x) => x.id === id);
    const price = w ? commandButton(`📈 Precio ${w.label || w.url}`, 'precio', w.id) : undefined;
    return price ? [price, stop] : [stop];
  });
  return buttons.length ? buttons : undefined;
}

/**
 * /vigilancias en Telegram: la vista única de `pa vigilancias` limitada a este chat (y
 * lo global), con cabeceras en negrita y un «📈 Precio …» de solo lectura por página
 * vigilada (hasta 8; equivale a /precio <id>). Nada de borrar con un toque.
 */
/** Nombre legible de cada lista de collectWatches (sus errores empiezan por «<lista>: »). */
const OVERVIEW_SOURCE_NAMES: Record<string, string> = {
  páginas: 'páginas vigiladas',
  ojo: 'ojo de águila',
  'pricewatch.json': 'vigilante de precios (pricewatch.json)',
  rutinas: 'rutinas',
};

/**
 * Nota de /vigilancias cuando alguna lista no se pudo leer: dice cuáles (sin el detalle
 * del error, que puede llevar rutas del PC) para que se sepa qué falta en la vista.
 */
export function vigilanciasErrorNote(errors: readonly string[]): string {
  if (!errors.length) return '';
  const names = [
    ...new Set(
      errors.map((e) => {
        const key = e.split(':')[0]?.trim() ?? '';
        return OVERVIEW_SOURCE_NAMES[key] ?? (key || 'otra lista');
      }),
    ),
  ];
  return `\n\n⚠️ No he podido leer: ${names.join(', ')}. Lo que sale arriba puede estar incompleto; \`pa vigilancias\` en el PC da el detalle.`;
}

export function vigilanciasReply(
  entries: readonly OverviewEntry[],
  chatId: string,
  now: number = Date.now(),
): { text: string; buttons: Array<{ label: string; action: string }> | undefined } {
  const shown = forChat(entries, chatId, 'telegram');
  const buttons = shown
    .filter((e) => e.kind === 'pagina')
    .slice(0, 8)
    .map((e) => commandButton(`📈 Precio ${e.label || e.target}`, 'precio', e.id))
    .filter((b): b is { label: string; action: string } => b !== undefined);
  // ⏸/▶️ de las rutinas de ESTE chat (las globales no: /cron solo ve las del chat). Lo
  // mismo que los botones de /cron: pausar no borra nada y se deshace con «Reanudar».
  const routines =
    cronListButtons(
      shown
        .filter((e) => e.kind === 'rutina' && e.scope.startsWith('telegram:'))
        .map((e) => ({ name: e.label, kind: 'schedule', schedule: e.target, enabled: e.enabled })),
    ) ?? [];
  buttons.push(...routines);
  return {
    text: marksWithTitles(formatOverview(shown, now), isOverviewTitle),
    buttons: buttons.length ? buttons : undefined,
  };
}

export function formatWatchList(list: readonly PageWatch[]): string {
  if (!list.length) return 'No vigilo ninguna página. Prueba /vigila <enlace>.';
  return [
    `Páginas vigiladas: ${list.length}`,
    ...list.map(
      (w) =>
        `${w.id} - ${w.label || w.url} - último valor: ${w.lastValue || 'pendiente'}` +
        `${w.targetCents !== null ? ` - objetivo ${eur(w.targetCents)}` : ''}` +
        `${w.dropPct !== null ? ` - aviso si baja un ${w.dropPct} %` : ''}`,
    ),
  ].join('\n');
}

/**
 * F15 `/skills buscar <texto>`: busca en el índice JSON de PA_SKILLS_INDEX_URL.
 * Solo lista nombre + URL; instalar sigue siendo `/skills instalar <url>`.
 */
export async function skillsSearchReply(
  query: string,
  indexUrl: string | undefined,
  fetchImpl?: typeof fetch,
): Promise<string> {
  const q = query.trim();
  if (!q) return 'Uso: /skills buscar <texto>';
  if (!indexUrl?.trim()) {
    return 'No hay índice de skills configurado. Pon PA_SKILLS_INDEX_URL=https://… (un JSON con [{ "name", "url", "description" }]) en .env.';
  }
  try {
    const entries = await fetchSkillIndex(indexUrl.trim(), { fetchImpl });
    return formatSkillSearch(q, searchSkillIndex(entries, q));
  } catch (err) {
    return failedReply('No he podido leer el índice de skills', err);
  }
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
