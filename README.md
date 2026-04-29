# LiteClaw

Lightweight agent runtime for local LLMs with WebUI, Discord, and WhatsApp support.

Designed for small models like Gemma 4 E4B running on consumer GPUs. LiteClaw aims to be a lighter alternative to OpenClaw while keeping a familiar workflow and migration path.

## Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

### [0.7.0] - 2026-04-29

#### Added

- **Scene-Aware D&D Flow**: Added canonical scene state, narrative validation, queued group actions, rest safety, and continuity checks for session threads.
- **Expanded D&D Character Tools**: Added avatar, skills, spells, inventory, dice, downtime, shop, death-save, inspiration, and richer stats/rest commands.
- **Advanced Combat Resolution**: Added pending player actions, active effects, defensive/improvised actions, buff/debuff/control skills, item weights, and round-level combat narration.
- **WhatsApp Progress UX**: Added command handling, progress tracker messages, send retries, reconnection behavior, and WhatsApp-specific markdown formatting.
- **Provider Compatibility**: Added native tool prompting, DSML tool-call parsing, provider refresh after config edits, top-k sampling, reasoning-content memory, and WebUI formatting rules.
- **Session Cleanup CLI**: Added `liteclaw channels logout --channel whatsapp` to clear the local WhatsApp pairing session.

#### Fixed

- **Discord Robustness**: Added gateway DNS checks, login retries, shard diagnostics, and debug token redaction.
- **Context Thresholds**: Derived default compaction thresholds from configured context size and budget.
- **Repository Hygiene**: Ignored `scratch/` and stopped `.gitignore` from ignoring itself.
- **Version Consistency**: Normalized package, CLI, runtime, gateway, migration, and default config version reporting to `0.7.0`.

### [0.6.3] - 2026-04-24

#### Added

- **The World of Elyndor**: Integrated a new high-fantasy preconfigured world with deep lore, regional factions, and RAG-assisted narrative generation.
- **Advanced D&D Combat Engine**: Implemented a stateful combat system with initiative tracking, persistent HP/AC management, and dynamic action menus.
- **Inventory & Skill Systems**: Added starter kits, weapon requirements, and class-specific skills with persistent usage tracking.
- **RAG Document Ingestion**: Added support for multi-format document ingestion (PDF, MD, TXT, DOCX) for session-aware knowledge retrieval.
- **Onboarding Improvements**: Streamlined player join flows and character profile initialization with persistent state.

#### Fixed

- **Git Tracking**: Added `brain/` directory to `.gitignore` to prevent generated session data and research logs from being tracked.
- **Version Consistency**: Normalized version reporting to `0.6.3` across all modules.

## Features

- **Autonomous Task Planner**: Breaks down complex requests into multi-step executable plans.
- **Smart Context Management**: Lazy tool loading, compaction, and rolling history to stay within model context limits.
- **Multi-Channel**: Native support for WebUI, Discord, and WhatsApp.
- **Discord DnD Sessions**: New slash-command workflow for multiplayer session threads, persistent player rosters, join/resume flows, partial-party resumes, and vote-based turn skipping.
- **Core Tools**: Filesystem access, command execution, web search/fetch, and native vision.
- **Safety First**: Cross-channel confirmations for destructive or sensitive actions.
- **Skills System**: Project-level skills support with selective prompt injection.

## Discord DnD Commands

LiteClaw now includes a lightweight DnD session subsystem for Discord:

- `/dnd start` creates a dedicated session thread and opens the lobby.
- `/dnd join` joins the current or specified session with a character profile, including joining midway through an active session.
- `/dnd begin` starts play and establishes turn order.
- `/dnd save` pauses the session and stores a checkpoint in SQLite.
- `/dnd resume` restores a saved session into the current thread, including partial-party mode.
- `/dnd restore` restores a specific checkpoint by checkpoint ID.
- `/dnd list` shows resumable sessions in the current guild.
- `/dnd checkpoints` lists saved checkpoints for a session.
- `/dnd available` and `/dnd unavailable` toggle whether your turns should be skipped.
- `/stats` shows your persistent character sheet, level, and XP progress.
- `/quest complete` and `/quest log` track quest completions and XP rewards.
- `/combat enter`, `/combat status`, `/combat menu`, and `/combat end` manage initiative and active-turn combat controls.
- `/vote skip-turn` opens a party vote to skip a player who is unavailable.
- `/end-turn` advances to the next available player.
- `/question` asks the GM an out-of-band question tied to the current DnD session without consuming a turn or polluting the main session context.
- `/question mode:private|public` controls whether the answer stays private or is visible to the table.

### DnD RAG Notes

- LiteClaw stores DnD retrieval data in its state directory and uses a local embedding server for session-aware GM answers.
- On this machine, the embedding bootstrap script is stored at `E:\Qwen3.6\start-embed-liteclaw.bat`.
- Starting or refreshing a DnD session automatically ensures the embedding server is running before syncing session context.

## Quick Start

```bash
git clone https://github.com/NikoDhrmwn/liteclaw.git
cd liteclaw
npm install
npx tsx src/cli.ts setup
npx tsx src/cli.ts gateway run
```

Open `http://localhost:7860` for the Web UI.

## Windows Setup

LiteClaw works well from Windows Terminal, PowerShell, or Command Prompt.

### PowerShell

```powershell
git clone https://github.com/NikoDhrmwn/liteclaw.git
Set-Location liteclaw
npm install
npx tsx src/cli.ts setup
npx tsx src/cli.ts gateway run
```

### Command Prompt

```bat
git clone https://github.com/NikoDhrmwn/liteclaw.git
cd liteclaw
npm install
npx tsx src/cli.ts setup
npx tsx src/cli.ts gateway run
```

### Batch launcher

If you prefer a double-clickable launcher on Windows:

```bat
start-liteclaw.bat
```

That script installs dependencies if needed and starts LiteClaw from the project folder.

## First-Time Configuration

Initialize the local state directory:

```bash
npx tsx src/cli.ts setup
```

This creates your LiteClaw state under:

- Windows: `%USERPROFILE%\.liteclaw`

Then put your secrets in:

```text
%USERPROFILE%\.liteclaw\.env
```

Example values:

```env
DISCORD_TOKEN=
GOOGLE_API_KEY=
GATEWAY_TOKEN=
LLM_BASE_URL=http://localhost:8080/v1
LLM_API_KEY=sk-local
LLM_MODEL=gemma-4-e4b-heretic
```

You can use the project-root [.env.example](.env.example) as a reference.

## Running LiteClaw

Start the gateway and WebUI:

```bash
npx tsx src/cli.ts gateway run
```

Or, after building:

```bash
npm run build
node dist/cli.js gateway run
```

Useful terminal commands:

```bash
npx tsx src/cli.ts doctor
npx tsx src/cli.ts status
npx tsx src/cli.ts channels status
npx tsx src/cli.ts message "hello"
```

## Migrating From OpenClaw

If you already use OpenClaw, LiteClaw can import configuration and local state.

### Default migration

```bash
npx tsx src/cli.ts migrate
```

This attempts to import from the default OpenClaw directory:

- Windows: `%USERPROFILE%\.openclaw`

### Custom migration path

```powershell
npx tsx src/cli.ts migrate --openclaw-dir "C:\Users\yourname\.openclaw"
```

Migration can bring over:

- model configuration
- Discord and WhatsApp channel config
- WhatsApp session files when present
- memory database
- personality files from the OpenClaw workspace

After migrating, review:

- `%USERPROFILE%\.liteclaw\config.yaml`
- `%USERPROFILE%\.liteclaw\.env`
- `%USERPROFILE%\.liteclaw\personality\`

## Common Commands

```bash
liteclaw gateway run
liteclaw channels login --channel discord
liteclaw channels login --channel whatsapp
liteclaw channels status
liteclaw status
liteclaw doctor
liteclaw config get <key>
liteclaw models list
liteclaw message "hello"
liteclaw migrate
```

If you have not installed the global CLI yet, use the same commands through `npx tsx src/cli.ts ...`.

Examples:

```bash
npx tsx src/cli.ts channels login --channel discord
npx tsx src/cli.ts channels login --channel whatsapp
npx tsx src/cli.ts config get gateway.port
npx tsx src/cli.ts models list
```

## Requirements

- Node.js >= 20
- A running LLM backend such as llama-server or Ollama, or a compatible hosted provider
- Discord bot token for Discord usage
- A linked phone for WhatsApp usage

## Security Notes

- Keep secrets in your LiteClaw state directory `.env`, not in the repository root.
- Do not commit runtime logs, SQLite databases, or WhatsApp session files.
- Review [SECURITY.md](SECURITY.md) before publishing a fork or deployment.
