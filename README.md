# LiteClaw

Lightweight agent runtime for local LLMs with WebUI, Discord, and WhatsApp support.

Designed for small models like Gemma 4 E4B running on consumer GPUs. LiteClaw aims to be a lighter alternative to OpenClaw while keeping a familiar workflow and migration path.

## Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

### [0.4.0] - 2026-04-22

#### Added

- **Autonomous Task Planner**: Introduced a state-of-the-art planning system that breaks complex user requests into discrete, executable tasks.
- **Task-Driven Execution Loop**: A new specialized loop for executing plan items, featuring strict structural enforcement and automatic "repair" nudges for local LLMs.
- **Smart Research Heuristics**: Enhanced the engine's ability to automatically detect when a request (like price checking or web research) requires a multi-step plan.
- **Discord Status Emojis**: Added planning progress tracking via Discord reactions (`🗺️`, `→`, `⚙`, `✓`, `X`).
- **Auto-Build Workflow**: Streamlined the development process—`npm run dev` now automatically builds the project and synchronizes WebUI assets.

#### Fixed

- **Silent Model Stalling**: Implemented a fallback mechanism to prevent "(No response)" messages when models complete tool calls without providing a final verbal summary.
- **Malformed JSON Recovery**: Added a robust, regex-backed JSON parser to the task engine to handle unquoted keys and common syntax errors from smaller models like Gemma 4.
- **Empty Response Fallback**: The Discord channel now automatically displays tool progress if the model's verbal response is empty.

### [0.3.2] - 2026-04-21

#### Added

- **WebUI Metrics**: Added real-time "tokens per second" (tok/s) and duration metrics displayed directly below assistant messages.
- **Thinking Accordion**: Replaced "Thinking..." text with a modern brutalist collapsible accordion. Reasoning now streams live into a hidden drawer to keep the UI clean.
- **Discord Instant Registration**: Added support for `DISCORD_GUILD_ID` for instant slash command updates (bypasses the 1-hour global propagation delay).

#### Fixed

- **Reasoning Persistence**: Optimized the engine to save agent thoughts in `<think>` tags, ensuring reasoning blocks survive page refreshes.
- **UI Glitch**: Fixed a regression where word-by-word reasoning streams would split into dozens of separate boxes.
- **Metrics Accuracy**: Updated metrics to include the reasoning time and tokens in the final `tok/s` calculation.

## Features

- **Autonomous Task Planner**: Breaks down complex requests into multi-step executable plans (new in 0.4.0).
- **Smart Context Management**: Lazy tool loading, compaction, and rolling history to stay within model context limits.
- **Multi-Channel**: Native support for WebUI, Discord, and WhatsApp.
- **Core Tools**: Filesystem access, command execution, web search/fetch, and native vision.
- **Safety First**: Cross-channel confirmations for destructive or sensitive actions.
- **Skills System**: Project-level skills support with selective prompt injection.

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
