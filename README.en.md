# Asistenta

> Language: **English** | [Español](README.md)

[![CI](https://github.com/nicogarrr/asistenta/actions/workflows/ci.yml/badge.svg)](https://github.com/nicogarrr/asistenta/actions/workflows/ci.yml)
[![Windows](https://github.com/nicogarrr/asistenta/actions/workflows/windows.yml/badge.svg)](https://github.com/nicogarrr/asistenta/actions/workflows/windows.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**A personal assistant on Telegram, with memory, multi-day goals and tools that work on your computer.**

Asistenta is a daemon that runs on your own PC. You talk to it through your private Telegram bot; it remembers context across conversations, proposes plans for multi-day goals that only run after your approval, and can use tools: browse the web, control the desktop, transcribe voice, run local OCR, send mail from your own account, control the TV and an iPhone. A local web panel shows chat, approvals, sessions, memory, status and audit, sharing the same permission flow as Telegram.

> **Status:** work in progress. A feature existing in the code does not mean it is configured or validated on your machine. Messages sent to the LLM provider leave your PC to that provider. Preset names do not guarantee quota or zero cost.

- **Problem it solves:** having an assistant that actually does things (not just chat) while your data, keys and approvals stay on your own machine.
- **Who it is for:** technical users who want a self-hosted personal agent and are comfortable creating a Telegram bot and an LLM API key.
- **Cost:** everything is free except the LLM API key, billed by your provider per use.

## How it works

```text
You on Telegram  <-->  Asistenta daemon (your PC)  <-->  LLM provider (the only paid part)
                              |
                     local web panel (loopback + token):
                     chat, approvals, memory, status, audit
                              |
        tools: browser, Windows desktop, voice, OCR, mail,
        calendar, reminders, routines, goals, TV, iPhone
```

## Start here (Windows, 10 minutes)

In this guide `pa` means `node dist\cli.js`, run from the Asistenta folder.

1. Install Node 24 or newer, free, from https://nodejs.org.
2. Download Asistenta. Best with git, so it updates itself: `git clone https://github.com/nicogarrr/asistenta` (if Windows says "git is not recognized", install it free from https://git-scm.com and open a new window). "Code -> Download ZIP" also works (unzip before opening anything), but then it does not self-update: download the ZIP again for a new version. Put it outside OneDrive (e.g. `C:\Asistenta`): OneDrive locks files and the install fails.
3. In Telegram, talk to @BotFather, create your bot with `/newbot` and copy the token it gives you.
4. Get the model key from your provider's website (OpenCode by default). This is the only paid part.
5. With internet access, double-click `instalar.bat`. It checks Node and npm, downloads the pieces, installs, compiles and asks for the token and the key (they are not shown as you paste them). If you see "Windows protected your PC", click "More info" and then "Run anyway".
6. When asked, send "hola" to your bot and confirm on the PC that it is you. That way only you can talk to it.
7. Double-click `levantar.bat`. If something is missing, you will see a green/red list with the fix for each failure.
8. Write to your bot. Done.
9. Optional: to start it automatically with Windows, `node dist\cli.js autostart install --start` ([details](docs/windows-startup.md)).

If something goes wrong, `node dist\cli.js iniciar --solo-comprobar` tells you what is missing without starting anything.

### .exe installer (recommended)

With the `Asistenta-Instalador-<version>.exe` installer you need neither Node nor consoles: next, next, done. It installs without administrator rights, appears in "Add or remove programs", can start with the PC and leaves a tray icon (open panel, pause, restart, see status). How to build and use it: [docs/app-windows.md](docs/app-windows.md). The `instalar.bat` steps remain equally valid.

To uninstall an .exe install: Settings -> Apps -> Asistenta -> Uninstall. Your data and keys stay unless you tick the box to delete them.

## Uninstalling Asistenta

1. Stop it: close the `levantar.bat` window or run `node dist\cli.js stop`.
2. If you enabled Windows autostart, remove it before deleting anything: `node dist\cli.js autostart uninstall`. If you delete the folder first, Windows keeps trying to start it every few minutes; in that case open Task Scheduler and delete `personal-agent-daemon`, `browserd-sidecar` and `Asistenta-vigilante`.
3. Delete the Asistenta folder.
4. Your data (memory, conversations and the secrets vault) lives separately, in `%USERPROFILE%\.local\share\personal-agent` (or in `PA_STATE_DIR` if you changed it). Delete it only if you are not coming back.
5. If you are not coming back, revoke the bot token in @BotFather (`/revoke`) and the model key on your provider's website.

## What is free

The only paid part is **the model key**: your provider bills you per use according to your plan. Everything else is free and runs on your PC:

- the program, the Telegram bot and the local web panel;
- memory, reminders, routines and goals;
- web search (by default it only uses free search engines: `PA_WEB_MAX_COST_EUR=0`);
- voice transcription and OCR, which run locally;
- PC and TV control, mail with your own account and calendar;
- autostart, the watchdog and self-update.

No other feature needs a key.

## What you can do

| Area | What you get | Limits |
| --- | --- | --- |
| Chat | Telegram conversations with your assistant | Requires your own bot token and provider key |
| Approvals | Pending decisions in Telegram and in the panel | Does not replace reviewing the result nor authorize any action |
| Voice dictation | Push-to-talk dictation in any app on your PC, fully local | Off by default; Windows with an interactive session; `PA_DICTADO=1` |
| Recurring tasks and reminders | "every Monday", "every two weeks", "next week", "next month" | Natural-language scheduling with grace-window catch-up |
| Feature requests by voice | Ask Asistenta for a new feature by talking to it; it proposes and validates changes itself | Only promoted with the full verification checklist |
| Optional features | Voice, mail, TV and iPhone control | Require their own dependencies, devices and configuration; they are not enabled by installing the chat |

### A goal, start to finish

1. Describe what you want to achieve and its limits.
2. Asistenta proposes a plan. It only activates after human confirmation and the corresponding permissions.
3. It runs the steps on their schedule, saves progress and reports news or blockers.
4. If a decision is missing, it stops to ask for it. A step marked as done does not by itself certify the quality of the result.

Goals are stored in SQLite with their conversation scope. The panel includes a **read-only view of the owner's goals**, with their states, blockers and steps. It does not allow activating, pausing or cancelling goals from that view. An editable board and a separate review state would be future work, not capabilities available from this guide.

## Contents

- [Start here](#start-here-windows-10-minutes)
- [What is free](#what-is-free)
- [Prerequisites](#prerequisites)
- [Preparing the code](#preparing-the-code)
- [Configuration without secrets](#configuration-without-secrets)
- [Secrets and Telegram](#secrets-and-telegram)
- [Check and start](#check-and-start)
- [Local web panel](#local-web-panel)
- [Autostart](#autostart)
- [Development and QA](#development-and-qa)
- [How it is organized](#how-it-is-organized)
- [Security and limits](#security-and-limits)
- [Glossary](#glossary)

## Prerequisites

This and the following sections cover manual installation (Linux or advanced). On Windows, [Start here](#start-here-windows-10-minutes) is enough.

- Node.js 24 or later and npm. The project enforces this version in `package.json`.
- Git to get the code.
- A Telegram bot and your numeric user ID.
- Access to a compatible provider. Model names and presets in the code do not guarantee quota or zero cost.
- Windows with an interactive session for desktop control. On Linux or without a desktop, use `PA_DESKTOP=off`; that does not cover every Windows feature.

Do not use a real account or session for automated tests. Do not paste keys into issues, chats or screenshots.

## Preparing the code

From the repository root:

```sh
node --version
npm ci
npm run build
node dist/cli.js --help
```

The following commands use `node dist/cli.js` so they do not depend on a globally installed `pa`. Building creates `dist/`; it does not download or start an LLM provider. Some dependencies may download binaries while installing. For the bundled Chromium browser:

```sh
npx playwright install chromium
```

With `PA_DESKTOP=off`, `doctor` skips the Windows desktop checks (screen, camera, microphone, windows). Also install the system dependencies Playwright indicates for your platform. You do not need browserd, Docker or TV features for basic chat.

## Configuration without secrets

Copy `.env.example` to `.env` and adjust only the options you need. The CLI loads the working directory's `.env` with Node's parser before loading the configuration. Variables already present in the environment take precedence. You can pass the file explicitly to make visible which configuration you are using:

```sh
node --env-file=.env dist/cli.js doctor
```

The example file contains no keys. Do not commit `.env` or the state directory. If you choose another folder with `PA_STATE_DIR`, use the same one for every command and for autostart.

The default code preset is `opencode`. `openrouter` and `opencode-local` also exist; the latter requires an already configured OpenCode server, reachable at the selected local URL and with its sandbox validated. This guide does not install it nor switch providers automatically.

## Secrets and Telegram

The default store uses DPAPI on Windows, bound to the user and machine. On other systems it uses a portable file with restricted permissions; **it is not DPAPI encryption**. Do not switch to portable on Windows to work around a vault failure.

1. In Telegram, open BotFather from its verified profile, create a bot with `/newbot` and keep the token private. Do not share it with third-party bots.
2. Get your own numeric user ID through a method you control. It is neither your `@username` nor the bot's ID. `instalar.bat` (or `node scripts/instalar.mjs`) detects it: you send "hola" to your bot and confirm on the PC that it is you.
3. Initialize the store once:

   ```sh
   node --env-file=.env dist/cli.js vault init
   ```

4. The names `serve` needs are `telegram:botToken`, `telegram:allowedUserIds` (comma-separated IDs) and `provider:apiKey`, when the provider requires a key. The current `vault set <key> <value>` command takes the value as an argument: it can end up in history and in the process list. Do not paste secrets in a shared, recorded or history-synced terminal. This guide does not present that path as safe secret input. `vault set-stdin <key>` allows private pipe input without the value in arguments and rejects an echoing terminal; see [`docs/vault-stdin-qa.md`](docs/vault-stdin-qa.md). It does not normalize the secret: it keeps spaces and a leading BOM; it only strips a final LF/CRLF. Do not write the secret in an echo/printf line, which puts it back into history. `node dist/cli.js setup` offers a partial guided local configuration; see [`docs/setup-qa.md`](docs/setup-qa.md) for its limits. It does not enable autostart nor make real calls to validate Telegram/model.

   With the portable backend you can privately prepare the state directory's `secrets.json` file, a JSON object whose names are those keys and whose values are strings. Restrict the directory to the user and the file to `600` on Unix **before** writing secrets. Do not use `vault get` to check them: it prints the value. `vault list` shows only names.

By default state lives in `~/.local/share/personal-agent`, also under the user profile on Windows. Store data there only on a system account you control. DPAPI offers no recovery when moving the vault to another machine: keep a private way to rotate the keys. Backups intentionally exclude the vault.

## Check and start

```sh
node --env-file=.env dist/cli.js doctor
node --env-file=.env dist/cli.js diagnose
```

`doctor` checks the local environment. `diagnose` reads local evidence and may include paths, logs or actions: review the output before sharing it. Neither one proves by itself that the full chat works.

`llm-health` makes real requests to configured providers. It can spend quota and, depending on the plan, money; do not run it as a harmless check:

```sh
node --env-file=.env dist/cli.js llm-health
```

Before starting, check that everything is in place (green/red list with the fix for each failure; it does not spend model calls):

```sh
node --env-file=.env dist/cli.js iniciar --solo-comprobar
```

Once you have verified access and its conditions, start in the foreground (`iniciar` without options checks and starts; `serve` starts directly):

```sh
node --env-file=.env dist/cli.js iniciar
```

On Windows, `levantar.bat` does the same with a double-click.

Send `/start` to your bot from the authorized user. A command that answers does not prove a model request works: afterwards try a generic question, with no private data. If credentials are missing or the token is invalid, fix the configuration; do not open the bot to every user to solve it.

To stop a foreground start, use Ctrl+C and wait for the shutdown. Do not kill a process just from a PID copied from a file.

- `status` and `watchdog --status` are point-in-time queries of PID and heartbeat; they confirm neither Telegram/LLM health nor installed supervision.
- On Linux, only in server mode, `node --env-file=.env dist/cli.js stop` uses authenticated local control and requires clean shutdown and released ownership. It needs `flock`, a private state directory and a daemon started with this version. It cannot stop an old daemon that does not publish that control. A timeout or unclean stop is a failure, not an invitation to kill by PID.
- On Windows, `node dist\cli.js stop` shuts it down and the watchdog will not restart it until `iniciar` or the next PC reboot.
- `restart` is rejected without changing the daemon because it cannot be verified whether a supervisor will relaunch it.
- On Windows, `autostart install` also sets up the "Asistenta-vigilante" watchdog, which restarts it if it crashes (see [Autostart](#autostart)). It covers processes that exit, not hangs of processes that stay alive.

On Linux the new controller requires the state directory to be private (700, current owner, no symlink) and the socket path to fit the Unix limit. If an old install has open permissions, startup fails closed: review its content and ownership before restricting them. It does not change those permissions silently. `PA_DESKTOP=on` is not supported on this Linux path.

## Local web panel

It is optional: set `PA_WEB_PORT` and `PA_WEB_TOKEN` through a private channel before starting. Without a token, the daemon does not start the panel. It listens on loopback by default, its APIs require Bearer and it only answers to local names (`127.0.0.1`, `localhost`, `[::1]`): any other Host header gets a 403, which stops DNS rebinding. If you serve the panel through your own proxy (e.g. `tailscale serve`), add its exact name to `PA_WEB_ALLOWED_HOSTS` (comma-separated). Do not publish the token, its initial URL or the browser storage. Do not expose the port to the Internet as if it had user management.

The panel and Telegram see the same pending approvals. The web view does not imply that every tool is configured or that the daemon is supervised.

## Autostart

See [`deploy/windows/README.md`](deploy/windows/README.md). Do not enable it until you have verified a manual start. The script uses the repository root as working directory; the CLI loads the optional `.env` from there. Variables already present in the task user's environment take precedence over the file. Do not put secrets in the task command. A native Windows install has not been validated in this QA round.

On Windows, the full autostart (a single `node dist/cli.js autostart install --start`, the prior `pa iniciar --solo-comprobar` list and the "Asistenta-vigilante" watchdog, which restarts it every 5 min if it crashes) is in [`docs/windows-startup.md`](docs/windows-startup.md); the watchdog has its own section at [Watchdog: "Asistenta-vigilante"](docs/windows-startup.md#vigilante-asistenta-vigilante). `pa stop` keeps it off until the PC restarts or `pa iniciar`, even if it was not running.

## Local OCR (optional)

Asistenta can extract text from an image or a scanned PDF with an OCR engine that runs on your PC: no network (except the first weights download), no paid APIs and without using your model keys. It is **off by default**; enabling it adds the `ocr_local` tool, which only reads files inside the working folder (and `PA_OCR_WATCH_DIR` if you have it). The existing `ocr` tool (screen text with Windows OCR) is unchanged.

Install (PowerShell, in the Asistenta folder; needs Python 3.10+ with the `py` launcher):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\ocr-sidecar\setup.ps1              # PP-OCRv5 (default)
powershell -ExecutionPolicy Bypass -File scripts\ocr-sidecar\setup.ps1 -Model glm   # GLM-OCR (best quality)
```

On Linux/WSL: `scripts/ocr-sidecar/setup.sh [ppocr|glm]`. Then, in `.env`: `PA_OCR_LOCAL=1` and, if you want GLM-OCR, `PA_OCR_MODEL=glm`. Restart Asistenta.

Measured on 30-Oct-2026 with 8 Spanish pages (receipt, web screenshot, scan, table, tilted photo, small print, ES/EN, handwriting), CPU only:

| Engine | Accuracy | s/page | RAM | License |
| --- | --- | --- | --- | --- |
| PP-OCRv5 (RapidOCR, ONNX) - default | 94.5 % | 1.3 | 0.8 GB | Apache-2.0 |
| GLM-OCR (`zai-org/GLM-OCR`) - `PA_OCR_MODEL=glm` | 98.5 % | 8.9 | 3.1 GB | MIT |

GLM-OCR downloads about 2 GB of weights the first time and needs PyTorch (CPU). PP-OCRv5 is weaker on web screenshots with menus; GLM-OCR, on very small print. PDFs are read up to 20 pages. If the engine is not installed, Asistenta tells you with the command to install it.

## Voice dictation anywhere (optional)

Hold a key, speak, release: the text appears wherever your cursor is (WhatsApp Web, Word, the browser, mail...). It runs entirely on your PC with the same local voice stack as voice notes: free, unlimited and keyless. **Off by default**; enable with `PA_DICTADO=1` and check the mic with `pa dictado prueba`. Default key is Ctrl + Windows (`PA_DICTADO_TECLA` to change it). It never types into password fields and stores neither audio nor text. Full guide: [`docs/dictado.md`](docs/dictado.md).

## Development and QA

```sh
npm run typecheck
npm run lint:check
npm run build
npm test
```

The suite has 1,200+ test files; the runner executes a general phase and a serial phase for resource tests. CI runs on every push on Linux (`CI` workflow) and Windows (`Windows` workflow), and the installer workflow attaches the `.exe` installer to each GitHub release. Browser/desktop tests require their dependencies; Linux tests do not replace Windows verification. A test with a simulated process does not prove a real daemon stopped.

- [`ROADMAP.md`](ROADMAP.md): work context and debts; may contain plans not yet implemented.
- [`docs/voz-piper.md`](docs/voz-piper.md): local fallback voice with Piper (opt-in `PA_PIPER_MODEL`).
- [`docs/resumen-diario.md`](docs/resumen-diario.md): morning briefing (opt-in `PA_BRIEFING=1`) and `/resumen hoy`.
- [`docs/startup-preflight-qa.md`](docs/startup-preflight-qa.md): startup validation and its limits.
- [`docs/diagnose-cli-qa.md`](docs/diagnose-cli-qa.md): local diagnostics and QA.
- [`docs/daemon-stop-qa.md`](docs/daemon-stop-qa.md): Linux stop, tests and limits.
- [`docs/tv-ordenes.md`](docs/tv-ordenes.md): LG TV commands and network wake-on-LAN; `pa tv mac auto` reads the TV's MAC from the network (with the TV on).
- [`docs/skills-incluidas.md`](docs/skills-incluidas.md): bundled engineering skills (diagnosing bugs, TDD), loaded only when coding.
- Scheduled routines: if the PC was off or asleep at a routine's time, when it comes back it runs ONCE late (noting the scheduled time) if the grace window has not passed (half the period, between 2 min and 2 h); if it has passed, it does not run and is recorded as missed. Disable: `PA_ROUTINE_CATCHUP=0`.
- Weekly evolution (`src/evolve`): a candidate is only promoted with the full verification checklist (written spec, no forbidden files, valid measurement, no more failures than the baseline) and leaves `state/evolve/promovido-<n>.receipt.md` next to the patch.

## How it is organized

```text
src/cli.ts         Startup and service wiring
src/channels/      Conversation channels
src/tools/         Tools available to the agent
src/goals/         Goal persistence, execution and notices
src/webui/         Local panel and authenticated API
src/               Memory, permissions, providers and services
browserd/          Optional browser service
deploy/            Per-platform instructions
test/, qa/         Tests and verification scenarios
docs/              Technical guides and QA limits
```

You do not need to start every component for basic chat. Read each feature's guide before adding services.

## Security and limits

- Do not use real data, accounts or sessions in automated tests.
- Do not commit secrets, state directories, private screenshots or unreviewed logs.
- The portable store is not equivalent to Windows DPAPI encryption. See [the safe stdin input](docs/vault-stdin-qa.md).
- Browsing, running a tool and getting a result are distinct facts. A mocked or Linux test does not certify Windows desktop control.
- External services have their own terms, quotas and data policies. Review the plan before enabling a key or an integration.
- Exfiltration gate: as soon as a turn reads something private (files, memory, mail, documents, screen, terminal...), a `fetch`, `download` or browser request carrying data (query, long path, user in the URL or long subdomain) to a domain the turn has not yet visited asks for approval showing the full URL. Before reading anything private, browsing stays free. `PA_TAINT_GATE=0` disables it.
- The delegation code is not presented here as an operational multi-agent system: its existence does not prove connection to the daemon.

## Glossary

- **Daemon:** the background program that stays running on your PC and answers on Telegram.
- **LLM provider:** the external service that runs the language model (default preset: OpenCode). The only paid part.
- **Vault:** the local secrets store. DPAPI on Windows; a restricted-permissions portable file elsewhere.
- **Panel:** the local web interface (chat, approvals, memory, status, audit), protected by a token and bound to loopback.
- **Approvals:** decisions the agent asks for before acting. Nothing sensitive runs without your confirmation.
- **Goals:** multi-day plans the agent proposes and only runs after your approval, step by step.
- **browserd:** optional browser service used by the web tools.
- **Watchdog ("Asistenta-vigilante"):** Windows task that restarts the daemon if it crashes.

## Contributing

Propose small changes, explain the problem and add a check that reproduces it. Use `npm run lint:check` to review without rewriting files. Do not describe a local test as validation of someone else's install. Keep implemented features, pending configuration and [roadmap](ROADMAP.md) proposals separate.

## License

MIT, the same license `package.json` declares: full text in [LICENSE](LICENSE). Dependencies keep their own licenses; for example, `ffmpeg-static` ships an ffmpeg binary (GPL-3.0 or later) and `lamejs` is LGPL-3.0.

`pa autostart install` also registers a watchdog ("Asistenta-vigilante" task, at logon and every 5 min) that restarts Asistenta if it is not running; if you stop it with `pa stop`, it stays off until the PC restarts or `pa iniciar`. `PA_WATCHDOG=0` disables it and `pa autostart status` tells you its state.

Asistenta also self-updates from `main` (`PA_AUTOUPDATE=1` by default): it waits until idle, fast-forwards, builds, restarts and tells you on Telegram what's new; if anything fails it rolls back to the previous version by itself. `pa autoupdate status|now|off|on`. Details in [docs/windows-startup.md](docs/windows-startup.md#autoactualización-desde-main).
